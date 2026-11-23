"""Validation selection and portable JSON formulas for genetic programming."""

import math
import operator
from dataclasses import asdict
from importlib.metadata import version

import numpy as np
from sklearn.utils.validation import check_array

from training.symbolic import GasSymbolicRegressor, SymbolicConfig

FUNCTIONS = {
    "add": (2, operator.add),
    "sub": (2, operator.sub),
    "mul": (2, operator.mul),
    "div": (2, lambda x, y: np.where(np.abs(y) > 0.001, np.divide(x, y), 1.0)),
    "abs": (1, np.abs),
    "min": (2, np.minimum),
    "max": (2, np.maximum),
}


def configurations(values):
    """Decode an explicitly supplied candidate list, never an implicit search."""
    if not isinstance(values, list) or not values:
        raise ValueError("Symbolic candidates must be a nonempty list")
    result = []
    for value in values:
        if not isinstance(value, dict):
            raise ValueError("Each symbolic candidate must be an object")
        value = dict(value)
        for name in ("init_depth", "function_set"):
            if name in value and isinstance(value[name], list):
                value[name] = tuple(value[name])
        try:
            config = SymbolicConfig(**value)
        except TypeError as error:
            raise ValueError("Invalid symbolic candidate fields") from error
        config.validate()
        result.append(config)
    return result


class FrozenSymbolicRegressor:
    """Evaluate a validated prefix tree without pickle, eval or gplearn imports."""

    def __init__(self, metadata):
        if metadata.get("version") != 1 or metadata.get("kind") != "gas_symbolic_formula":
            raise ValueError("Incompatible symbolic formula")
        names = metadata.get("feature_names")
        if not isinstance(names, list) or not names:
            raise ValueError("Invalid symbolic feature names")
        self.feature_names_ = tuple(GasSymbolicRegressor._feature_names(names, len(names)))
        self.n_features_in_ = len(names)
        target = metadata.get("target_transform", {})
        if (
            target.get("fit_split") != "train"
            or target.get("unit") != "gas"
            or any(
                type(target.get(k)) not in (int, float) or not math.isfinite(target[k])
                for k in ("mean", "scale")
            )
            or target["scale"] <= 0
        ):
            raise ValueError("Invalid symbolic target transform")
        program = metadata.get("program")
        if not isinstance(program, list) or not program:
            raise ValueError("Empty symbolic program")
        pending = 1
        for node in program:
            if pending <= 0 or not isinstance(node, dict) or len(node) != 1:
                raise ValueError("Malformed symbolic program")
            pending -= 1
            if "function" in node:
                if not isinstance(node["function"], str) or node["function"] not in FUNCTIONS:
                    raise ValueError("Unsupported symbolic operator")
                pending += FUNCTIONS[node["function"]][0]
            elif "feature" in node:
                if type(node["feature"]) is not int or not 0 <= node["feature"] < len(names):
                    raise ValueError("Invalid symbolic feature index")
            elif "constant" in node:
                value = node["constant"]
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("Invalid symbolic constant")
            else:
                raise ValueError("Unknown symbolic node")
        if pending:
            raise ValueError("Incomplete symbolic program")
        self.program_ = [dict(node) for node in program]
        self.target_mean_, self.target_scale_ = target["mean"], target["scale"]

    def predict(self, x):
        x = check_array(x, dtype=np.float64)
        if x.shape[1] != self.n_features_in_:
            raise ValueError("Prediction feature dimension differs from training")
        stack = []
        with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
            for node in reversed(self.program_):
                if "feature" in node:
                    stack.append(x[:, node["feature"]])
                elif "constant" in node:
                    stack.append(np.full(len(x), node["constant"], dtype=np.float64))
                else:
                    arity, function = FUNCTIONS[node["function"]]
                    stack.append(function(*[stack.pop() for _ in range(arity)]))
            predictions = stack[0] * self.target_scale_ + self.target_mean_
        if not np.isfinite(predictions).all():
            raise ValueError("Nonfinite gas predictions")
        return predictions


def formula_metadata(model):
    nodes = []
    for node in model.estimator_._program.program:
        if isinstance(node, (int, np.integer)):
            nodes.append({"feature": int(node)})
        elif isinstance(node, (float, np.floating)):
            nodes.append({"constant": float(node)})
        else:
            nodes.append({"function": node.name})
    return {
        "version": 1,
        "kind": "gas_symbolic_formula",
        "feature_names": list(model.feature_names_),
        "target_transform": {
            "mean": model.target_mean_,
            "scale": model.target_scale_,
            "fit_split": "train",
            "unit": "gas",
        },
        "program": nodes,
        "expression_display_only": model.expression_,
    }


def train_symbolic(train_x, train_y, validation_x, validation_y, feature_names, candidates):
    if not candidates:
        raise ValueError("Symbolic candidates must be nonempty")
    for config in candidates:
        if not isinstance(config, SymbolicConfig):
            raise TypeError("Expected SymbolicConfig candidates")
        config.validate()
    train_x, validation_x = np.asarray(train_x), np.asarray(validation_x)
    validation_y = np.asarray(validation_y, dtype=np.float64)
    if validation_y.shape != (len(validation_x),) or not len(validation_y):
        raise ValueError("Empty or misaligned symbolic validation targets")
    if not np.isfinite(validation_y).all() or np.any(validation_y <= 0):
        raise ValueError("Invalid symbolic validation targets")
    records, selected, best = [], None, math.inf
    for index, config in enumerate(candidates):
        model = GasSymbolicRegressor(config).fit(train_x, train_y, feature_names=feature_names)
        metadata = formula_metadata(model)
        frozen = FrozenSymbolicRegressor(metadata)
        predictions = frozen.predict(validation_x)
        np.testing.assert_allclose(predictions, model.predict(validation_x), rtol=0, atol=1e-9)
        mae = float(np.mean(np.abs(validation_y - predictions)))
        if not math.isfinite(mae):
            raise ValueError("Nonfinite symbolic validation MAE")
        records.append(
            {
                "candidate": index,
                "configuration": asdict(config),
                "validation_mae_gas": mae,
                "program_length": len(metadata["program"]),
                "program_depth": int(model.estimator_._program.depth_),
                "generations": {
                    key: [
                        None
                        if not np.isfinite(v)
                        else float(v)
                        if isinstance(v, (float, np.floating))
                        else int(v)
                        for v in vals
                    ]
                    for key, vals in model.estimator_.run_details_.items()
                },
            }
        )
        if mae < best:
            best, selected = mae, metadata
            selected_index = index
    history = {
        "version": 1,
        "selection_split": "validation",
        "selection_metric": "mae_gas",
        "tie_break": "first_candidate",
        "selected_candidate": selected_index,
        "candidates": records,
        "runtime": {"engine": "gplearn", "version": version("gplearn"), "n_jobs": 1},
    }
    return selected, history
