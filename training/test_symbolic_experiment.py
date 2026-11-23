import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd

from training.bundles import load_run, predict_rows, prepare, train_bundle
from training.evaluation import evaluate
from training.fixtures import poc_extraction
from training.prepare_dataset import digest, read_json, write_json
from training.preprocessing import TrainingPreprocessor
from training.splits import block_bounds
from training.symbolic import GasSymbolicRegressor, SymbolicConfig
from training.symbolic_experiment import FrozenSymbolicRegressor, configurations, train_symbolic
from training.trainer import TrainConfig


def formula(program):
    return {
        "version": 1,
        "kind": "gas_symbolic_formula",
        "feature_names": ["x", "y"],
        "target_transform": {"mean": 10, "scale": 2, "fit_split": "train", "unit": "gas"},
        "program": program,
    }


class FrozenFormulaTests(unittest.TestCase):
    def test_operations_order_constants_features_and_protected_division(self):
        x = np.array([[3, 2], [-4, 0], [1, 0.001], [1, -0.001], [2, 0.002]])
        for name, expected in (
            ("add", x[:, 0] + x[:, 1]),
            ("sub", x[:, 0] - x[:, 1]),
            ("mul", x[:, 0] * x[:, 1]),
            ("div", [1.5, 1, 1, 1, 1000]),
            ("min", np.minimum(x[:, 0], x[:, 1])),
            ("max", np.maximum(x[:, 0], x[:, 1])),
        ):
            model = FrozenSymbolicRegressor(
                formula([{"function": name}, {"feature": 0}, {"feature": 1}])
            )
            np.testing.assert_array_equal(model.predict(x), 10 + 2 * np.asarray(expected))
        model = FrozenSymbolicRegressor(
            formula(
                [
                    {"function": "sub"},
                    {"function": "abs"},
                    {"feature": 0},
                    {"constant": 20.123456789},
                ]
            )
        )
        np.testing.assert_array_equal(model.predict(x), 10 + 2 * (np.abs(x[:, 0]) - 20.123456789))
        self.assertLess(model.predict(x)[0], 0)

    def test_malformed_metadata_and_prediction_failures(self):
        valid = formula([{"feature": 0}])
        for changes in (
            {"version": 999},
            {"feature_names": []},
            {"feature_names": ["x", "x"]},
            {"program": []},
            {"program": [{"function": "eval"}]},
            {"program": [{"feature": -1}]},
            {"program": [{"feature": 2}]},
            {"program": [{"feature": True}]},
            {"program": [{"constant": float("inf")}]},
            {"program": [{"function": "add"}, {"feature": 0}]},
            {"program": [{"feature": 0}, {"constant": 1}]},
            {"program": [{"feature": 0, "constant": 1}]},
            {"target_transform": {"mean": 1, "scale": 0, "fit_split": "train", "unit": "gas"}},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                FrozenSymbolicRegressor(valid | changes)
        model = FrozenSymbolicRegressor(valid)
        for x in ([], [[1]], [[float("nan"), 0]]):
            with self.assertRaises(ValueError):
                model.predict(x)
        overflow = FrozenSymbolicRegressor(
            formula([{"function": "mul"}, {"constant": 1e308}, {"feature": 0}])
        )
        with self.assertRaisesRegex(ValueError, "Nonfinite"):
            overflow.predict([[100, 0]])

    def test_configurations(self):
        configs = configurations([{"init_depth": [1, 2], "function_set": ["add"], "seed": 7}])
        self.assertEqual(configs[0].function_set, ("add",))
        for values in ([], {}, [1], [{"generations": 0}], [{"unknown": 1}]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                configurations(values)

    def test_selection_uses_validation_mae_and_preserves_training_inputs(self):
        train_x, train_y = np.zeros((3, 2)), [1000, 2000, 3000]
        validation_x = np.ones((2, 2))
        formulas = [formula([{"constant": c}]) for c in (0, 5)]
        models = [
            SimpleNamespace(
                predict=lambda x, value=value: np.full(len(x), value),
                estimator_=SimpleNamespace(
                    _program=SimpleNamespace(depth_=0),
                    run_details_={"generation": [0], "best_oob_fitness": [float("nan")]},
                ),
            )
            for value in (10, 20)
        ]
        for labels, winner in (([20, 20], 1), ([10, 10], 0)):
            with (
                patch.object(GasSymbolicRegressor, "fit", side_effect=models) as fitted,
                patch("training.symbolic_experiment.formula_metadata", side_effect=formulas),
                patch("training.symbolic_experiment.version", return_value="test"),
            ):
                selected, history = train_symbolic(
                    train_x,
                    train_y,
                    validation_x,
                    labels,
                    ["x", "y"],
                    [SymbolicConfig(), SymbolicConfig(seed=7)],
                )
            self.assertEqual(history["selected_candidate"], winner)
            self.assertEqual(selected, formulas[winner])
            for call in fitted.call_args_list:
                np.testing.assert_array_equal(call.args[0], train_x)
                self.assertEqual(call.args[1], train_y)
            self.assertIsNone(history["candidates"][0]["generations"]["best_oob_fitness"][0])


@unittest.skipUnless(importlib.util.find_spec("gplearn"), "Optional gplearn is not installed")
class SymbolicExperimentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = SymbolicConfig(
            population_size=12, generations=2, tournament_size=3, init_depth=(1, 2)
        )

    def test_validation_selection_ties_scaling_and_json_roundtrip(self):
        x = np.array([[0, 0], [0, 1], [1, 0], [1, 1]], dtype=float)
        y = np.array([21000, 30000, 40000, 50000])
        selected, history = train_symbolic(x, y, x, y, ["x", "y"], [self.config, self.config])
        self.assertEqual(history["selected_candidate"], 0)
        self.assertEqual(selected["target_transform"]["mean"], y.mean())
        self.assertEqual(history["selection_split"], "validation")
        write_json(self.root / "model.json", selected)
        reloaded = FrozenSymbolicRegressor(read_json(self.root / "model.json"))
        engine = GasSymbolicRegressor(self.config).fit(x, y, feature_names=["x", "y"])
        np.testing.assert_array_equal(reloaded.predict(x), engine.predict(x))
        # Changing validation labels can change selection, never candidate fitting/scaling.
        changed, _ = train_symbolic(x, y, x, y + 100000, ["x", "y"], [self.config])
        self.assertEqual(selected, changed)
        for bad in ([], [float("nan")] * 4, [0] * 4):
            with self.assertRaises(ValueError):
                train_symbolic(x, y, x, bad, ["x", "y"], [self.config])

    def test_e3_pipeline_comparison_is_frozen_aligned_and_portable(self):
        bounds = block_bounds(19010000, 19059999)
        bounds["unseen-contract"] = bounds["test"]
        source, prepared, run = [self.root / n for n in ("source", "prepared", "run")]
        poc_extraction(source, bounds)
        prepare(source, prepared, "e3")
        self.assertEqual(read_json(prepared / "provenance.json")["mode"], "e3")
        original = read_json

        def guarded(path):
            self.assertNotIn(Path(path).name, ("test.json", "unseen-contract.json"))
            return original(path)

        with (
            patch("training.bundles.read_json", side_effect=guarded),
            patch("socket.create_connection", side_effect=AssertionError("Network access")),
        ):
            train_bundle(prepared, run, TrainConfig(max_epochs=2), symbolic_configs=[self.config])
        rows = read_json(prepared / "unseen-contract.json")
        with patch("training.evaluation.read_json", side_effect=guarded):
            validation = evaluate(run, prepared, validation_only=True)
        self.assertEqual(validation["final_tests"], {})
        self.assertFalse((run / "evaluation").exists())
        with (
            patch.object(GasSymbolicRegressor, "fit", side_effect=AssertionError("refit")),
            patch.object(TrainingPreprocessor, "fit", side_effect=AssertionError("refit")),
            patch.dict("sys.modules", {"gplearn": None, "gplearn.genetic": None}),
        ):
            predictions = predict_rows(run, rows)
            result = evaluate(run, prepared)
            self.assertTrue(evaluate(run, prepared, verification=True)["verification_only"])
        self.assertFalse(result["pipeline_check_only"])
        for section in [result["validation_diagnostics"], *result["final_tests"].values()]:
            self.assertEqual(set(section["estimators"]), {"mlp", "selector_median", "symbolic"})
            self.assertTrue(
                all(s["aggregate"]["count"] == 2 for s in section["estimators"].values())
            )
        frame = pd.read_csv(run / "evaluation/unseen-contract.csv")
        np.testing.assert_allclose(
            frame.symbolic_prediction, predictions["symbolic"], rtol=0, atol=1e-9
        )
        np.testing.assert_allclose(
            frame.actual_gasUsed - frame.symbolic_prediction,
            frame.symbolic_residual,
            rtol=0,
            atol=1e-9,
        )
        # Full hashes plus semantic feature/preprocessor binding reject swapped formulas.
        path = run / "symbolic.json"
        metadata = read_json(path)
        manifest = read_json(run / "manifest.json")
        for changes in (
            {"feature_names": ["wrong"]},
            {"preprocessing_sha256": "wrong"},
            {"program": [{"function": "eval"}]},
        ):
            altered = copy.deepcopy(metadata)
            altered.update(changes)
            write_json(path, altered)
            with self.assertRaisesRegex(ValueError, "integrity"):
                load_run(run)
            updated = copy.deepcopy(manifest)
            updated["artifacts"]["symbolic.json"] = digest(path)
            write_json(run / "manifest.json", updated)
            with self.assertRaises(ValueError):
                load_run(run)
            write_json(run / "manifest.json", manifest)
