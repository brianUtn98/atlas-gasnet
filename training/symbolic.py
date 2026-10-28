"""Standalone genetic-programming regressor; no dataset or experiment orchestration."""

from dataclasses import dataclass

import numpy as np
from sklearn.exceptions import NotFittedError
from sklearn.utils.validation import check_array, check_X_y

OPERATORS = frozenset({"add", "sub", "mul", "div", "abs", "min", "max"})


@dataclass(frozen=True)
class SymbolicConfig:
    """Starting values, not experimentally selected hyperparameters.

    init_depth limits initial trees only. Parsimony discourages, but does not
    prohibit, larger trees during evolution. Fitness uses normalized-target MAE.
    """

    population_size: int = 500
    generations: int = 20
    tournament_size: int = 20
    init_depth: tuple[int, int] = (2, 4)
    function_set: tuple[str, ...] = ("add", "sub", "mul", "div", "abs", "min", "max")
    parsimony_coefficient: float = 0.001
    seed: int = 42

    def validate(self):
        for field in ("population_size", "generations", "tournament_size"):
            if type(getattr(self, field)) is not int or getattr(self, field) < 1:
                raise ValueError(f"Invalid {field}")
        if not 2 <= self.tournament_size <= self.population_size:
            raise ValueError("tournament_size must be between 2 and population_size")
        if (
            not isinstance(self.init_depth, tuple)
            or len(self.init_depth) != 2
            or any(type(depth) is not int for depth in self.init_depth)
            or not 1 <= self.init_depth[0] <= self.init_depth[1]
        ):
            raise ValueError("init_depth must be an ordered pair of positive integers")
        if (
            not isinstance(self.function_set, tuple)
            or not self.function_set
            or any(
                type(operator) is not str or operator not in OPERATORS
                for operator in self.function_set
            )
            or len(set(self.function_set)) != len(self.function_set)
        ):
            raise ValueError("function_set must contain distinct supported operator names")
        penalty = self.parsimony_coefficient
        if type(penalty) not in (int, float) or not np.isfinite(penalty) or penalty < 0:
            raise ValueError("parsimony_coefficient must be finite and nonnegative")
        if type(self.seed) is not int or not 0 <= self.seed < 2**32:
            raise ValueError("seed must be an integer in [0, 2**32)")


class GasSymbolicRegressor:
    """Learn a gasUsed formula from an already prepared, ordered feature matrix.

    fit accepts positive gas-unit labels shaped (N,) or (N, 1). Target scaling is
    fitted only on the provided training labels; predict returns gas units with
    shape (N,), without clipping or rounding. Callers own feature eligibility,
    preprocessing, splits, validation and model selection. No files or RPCs are
    accessed by this model. The optional gplearn dependency is loaded on fit.
    """

    def __init__(self, config=None):
        self.config = SymbolicConfig() if config is None else config
        if not isinstance(self.config, SymbolicConfig):
            raise TypeError("config must be a SymbolicConfig")
        self.config.validate()

    def fit(self, x, y, *, feature_names=None):
        """Evolve formulas using training data only; return this fitted model."""
        self.config.validate()
        target = np.asarray(y)
        if target.ndim == 2 and target.shape[1] == 1:
            target = target[:, 0]
        x, target = check_X_y(x, target, dtype=np.float64, y_numeric=True, ensure_min_samples=2)
        target = np.asarray(target, dtype=np.float64)
        if np.any(target <= 0):
            raise ValueError("gasUsed labels must be positive")
        names = self._feature_names(feature_names, x.shape[1])
        with np.errstate(over="ignore", invalid="ignore"):
            mean, scale = float(target.mean()), float(target.std())
        if not np.isfinite(mean) or not np.isfinite(scale):
            raise ValueError("Target scaling is nonfinite")
        scale = scale if scale > 0 else 1.0
        normalized = (target - mean) / scale
        if not np.isfinite(normalized).all():
            raise ValueError("Normalized training targets are nonfinite")

        try:
            from gplearn.genetic import SymbolicRegressor
        except ImportError as error:
            raise ImportError(
                "Install symbolic-model dependencies with "
                "python -m pip install -r training/requirements-symbolic.txt"
            ) from error

        estimator = SymbolicRegressor(
            population_size=self.config.population_size,
            generations=self.config.generations,
            tournament_size=self.config.tournament_size,
            init_depth=self.config.init_depth,
            function_set=self.config.function_set,
            metric="mean absolute error",
            parsimony_coefficient=self.config.parsimony_coefficient,
            feature_names=names,
            random_state=self.config.seed,
            n_jobs=1,
            max_samples=1.0,
            warm_start=False,
        )
        estimator.fit(x, normalized)
        if not np.isfinite(estimator.predict(x)).all():
            raise ValueError("Evolution produced nonfinite training predictions")

        # Publish fitted state only after successful validation and evolution.
        self.estimator_ = estimator
        self.feature_names_ = tuple(names)
        self.n_features_in_ = x.shape[1]
        self.target_mean_ = mean
        self.target_scale_ = scale
        return self

    @staticmethod
    def _feature_names(names, dimension):
        if names is None:
            return [f"X{index}" for index in range(dimension)]
        if isinstance(names, str):
            raise ValueError("feature_names must be a sequence of names")
        names = list(names)
        if (
            len(names) != dimension
            or any(not isinstance(name, str) or not name.strip() for name in names)
            or len(set(names)) != len(names)
        ):
            raise ValueError("feature_names must be nonempty, unique and match the columns")
        return names

    def _require_fitted(self):
        if not hasattr(self, "estimator_"):
            raise NotFittedError("Call fit before prediction or formula inspection")

    def predict(self, x):
        """Predict gas units using the same feature order used during fit."""
        self._require_fitted()
        x = check_array(x, dtype=np.float64)
        if x.shape[1] != self.n_features_in_:
            raise ValueError("Prediction feature dimension differs from training")
        with np.errstate(over="ignore", invalid="ignore"):
            predictions = self.estimator_.predict(x) * self.target_scale_ + self.target_mean_
        if not np.isfinite(predictions).all():
            raise ValueError("Nonfinite gas predictions")
        return predictions

    @property
    def expression_(self):
        """Display-only gas-unit expression; gplearn rounds internal constants.

        Use predict for inference. Do not eval this string or use it as a model
        serialization format. The pinned engine exposes its formula as _program.
        """
        self._require_fitted()
        return (
            f"{self.target_mean_:.17g} + {self.target_scale_:.17g} * ({self.estimator_._program})"
        )
