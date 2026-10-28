"""Small synthetic unit fixtures only; no PoC experiments or held-out labels."""

import importlib.util
import unittest
from dataclasses import replace
from unittest.mock import patch

import numpy as np
from sklearn.exceptions import NotFittedError

from training.symbolic import GasSymbolicRegressor, SymbolicConfig


class SymbolicConfigTests(unittest.TestCase):
    def test_invalid_configurations(self):
        for changes in (
            {"population_size": 0},
            {"generations": True},
            {"generations": 0},
            {"tournament_size": 1},
            {"tournament_size": 501},
            {"init_depth": (3, 2)},
            {"init_depth": (0, 2)},
            {"init_depth": (1, True)},
            {"function_set": ()},
            {"function_set": ("eval",)},
            {"function_set": ("add", "add")},
            {"function_set": ([],)},
            {"parsimony_coefficient": -1},
            {"parsimony_coefficient": float("nan")},
            {"parsimony_coefficient": float("inf")},
            {"seed": -1},
            {"seed": 2**32},
            {"seed": True},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                GasSymbolicRegressor(replace(SymbolicConfig(), **changes))
        with self.assertRaises(TypeError):
            GasSymbolicRegressor({})

    def test_unfitted_model(self):
        model = GasSymbolicRegressor()
        with self.assertRaises(NotFittedError):
            model.predict([[0]])
        with self.assertRaises(NotFittedError):
            _ = model.expression_

    def test_invalid_training_data_and_feature_names(self):
        x = np.array([[0, 1], [1, 0]], dtype=float)
        y = np.array([30000, 45000])
        for bad_x, bad_y in (
            (x[:0], y[:0]),
            (x[:1], y[:1]),
            (x, y[:1]),
            (x, [[1, 2], [3, 4]]),
            (x * np.nan, y),
            (x, [np.nan, 1]),
            (x, [np.inf, 1]),
            (x, [0, 1]),
            (x, [-1, 1]),
            (x, [1e308, 1e308]),
        ):
            with self.subTest(x=bad_x, y=bad_y), self.assertRaises(ValueError):
                GasSymbolicRegressor().fit(bad_x, bad_y)
        for names in (["a"], ["a", "a"], ["a", " "], ["a", 3], "ab"):
            with self.subTest(names=names), self.assertRaises(ValueError):
                GasSymbolicRegressor().fit(x, y, feature_names=names)


@unittest.skipUnless(importlib.util.find_spec("gplearn"), "Optional gplearn is not installed")
class SymbolicModelTests(unittest.TestCase):
    def setUp(self):
        self.x = np.array([[0, 0], [0, 1], [1, 0], [1, 1], [2, 1], [2, 2]], dtype=float)
        self.y = 30000 + 17100 * self.x[:, 0] - 4800 * self.x[:, 1]
        self.config = SymbolicConfig(
            population_size=24, generations=3, tournament_size=3, init_depth=(1, 2)
        )

    def test_real_evolution_shapes_names_and_repeatability(self):
        models = [
            GasSymbolicRegressor(self.config).fit(
                self.x, self.y, feature_names=["recipient_zero", "sender_equal"]
            )
            for _ in range(2)
        ]
        for model in models:
            predictions = model.predict(self.x)
            self.assertEqual(predictions.shape, (len(self.x),))
            self.assertTrue(np.isfinite(predictions).all())
            self.assertEqual(model.n_features_in_, 2)
            self.assertEqual(model.feature_names_, ("recipient_zero", "sender_equal"))
            self.assertEqual(len(model.estimator_.run_details_["generation"]), 3)
            self.assertIn(str(model.estimator_._program), model.expression_)
        np.testing.assert_array_equal(models[0].predict(self.x), models[1].predict(self.x))
        self.assertEqual(models[0].expression_, models[1].expression_)

    def test_gas_units_column_targets_and_frozen_scaling(self):
        model = GasSymbolicRegressor(self.config).fit(self.x, self.y[:, None])
        self.assertAlmostEqual(model.target_mean_, self.y.mean())
        self.assertAlmostEqual(model.target_scale_, self.y.std())
        with patch.object(model.estimator_, "predict", return_value=np.array([0.0, 1.0])):
            result = model.predict([[0, 0], [1000, 1000]])
        np.testing.assert_allclose(
            result, [self.y.mean(), self.y.mean() + self.y.std()], rtol=0, atol=1e-9
        )
        self.assertAlmostEqual(model.target_mean_, self.y.mean())
        self.assertAlmostEqual(model.target_scale_, self.y.std())
        self.assertEqual(model.feature_names_, ("X0", "X1"))

    def test_constant_labels_and_single_prediction(self):
        model = GasSymbolicRegressor(self.config).fit(self.x, np.full(len(self.x), 21000))
        self.assertEqual(model.target_mean_, 21000)
        self.assertEqual(model.target_scale_, 1)
        self.assertEqual(model.predict(self.x[:1]).shape, (1,))

    def test_prediction_failures_and_no_clipping(self):
        model = GasSymbolicRegressor(self.config).fit(self.x, self.y)
        for x in ([], [[0]], [[0, 1, 2]], [[np.nan, 1]], [[np.inf, 1]]):
            with self.subTest(x=x), self.assertRaises(ValueError):
                model.predict(x)
        with (
            patch.object(model.estimator_, "predict", return_value=np.array([np.inf])),
            self.assertRaises(ValueError),
        ):
            model.predict(self.x[:1])
        with patch.object(model.estimator_, "predict", return_value=np.array([-100.123])):
            prediction = model.predict(self.x[:1])[0]
        self.assertLess(prediction, 0)
        self.assertNotEqual(prediction, round(prediction))

    def test_failed_refit_keeps_previous_model(self):
        model = GasSymbolicRegressor(self.config).fit(self.x, self.y)
        original = model.predict(self.x)
        with (
            patch("gplearn.genetic.SymbolicRegressor.fit", side_effect=RuntimeError("failure")),
            self.assertRaises(RuntimeError),
        ):
            model.fit(self.x, self.y + 1000)
        np.testing.assert_array_equal(original, model.predict(self.x))


if __name__ == "__main__":
    unittest.main()
