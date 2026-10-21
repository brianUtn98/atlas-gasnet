import unittest
from dataclasses import replace
from unittest.mock import patch

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from training.trainer import EarlyStopping, GasMLP, TrainConfig, epoch_loss, predict, train


class TrainerTests(unittest.TestCase):
    def setUp(self):
        self.x = torch.arange(15, dtype=torch.float32).reshape(5, 3) / 10
        self.y = torch.tensor([[10], [20], [30], [40], [50]], dtype=torch.int64)
        self.config = TrainConfig(max_epochs=4, batch_size=2, patience=2)

    def test_shapes_backward_and_partial_weighting(self):
        model = GasMLP(3)
        self.assertEqual(model(self.x).shape, (5, 1))
        model(self.x).sum().backward()
        self.assertTrue(all(p.grad is not None for p in model.parameters()))
        zero = nn.Linear(3, 1)
        with torch.no_grad():
            zero.weight.zero_()
            zero.bias.zero_()
        loader = DataLoader(TensorDataset(self.x, self.y.float()), batch_size=2)
        self.assertAlmostEqual(epoch_loss(zero, loader, "cpu"), 1100)
        self.assertEqual(predict(zero, self.x, {"mean": 12, "scale": 3}), [12] * 5)
        with self.assertRaises(ValueError):
            epoch_loss(zero, [], "cpu")

    def test_scripted_stopping_and_cloned_weights(self):
        model = nn.Linear(1, 1, bias=False)
        stopper = EarlyStopping(2, 0.1)
        for epoch, (loss, stop) in enumerate(
            [(1, False), (0.95, False), (0.8, False), (0.8, False), (0.75, True)], 1
        ):
            with torch.no_grad():
                model.weight.fill_(epoch)
            self.assertEqual(stopper.observe(loss, model, epoch), stop)
        stopper.restore(model)
        self.assertEqual(model.weight.item(), 3)
        self.assertEqual(stopper.best_epoch, 3)

    def test_restoration_stop_and_epoch_limit(self):
        for patience, epochs, reason in ((1, 4, "patience"), (10, 3, "epoch_limit")):
            captured = []

            def losses(model, loader, device, optimizer=None, captured=captured):
                if optimizer is not None:
                    with torch.no_grad():
                        next(model.parameters()).add_(1)
                    captured.append(next(model.parameters()).clone())
                    return 1.0
                return float(len(captured))

            with patch("training.trainer.epoch_loss", side_effect=losses):
                model, _, history, _ = train(
                    self.x,
                    self.y,
                    self.x,
                    self.y,
                    replace(self.config, patience=patience, max_epochs=epochs),
                )
            torch.testing.assert_close(next(model.parameters()), captured[0])
            self.assertEqual(history["stop_reason"], reason)

    def test_deterministic_and_constant_targets(self):
        results = [train(self.x, self.y, self.x, self.y, self.config) for _ in range(2)]
        self.assertEqual(results[0][2], results[1][2])
        for a, b in zip(results[0][0].parameters(), results[1][0].parameters(), strict=True):
            torch.testing.assert_close(a, b, rtol=0, atol=1e-6)
        for model, target, _, _ in results:
            self.assertEqual(len(predict(model, self.x, target)), 5)
        _, target, _, _ = train(self.x, self.y * 0 + 7, self.x, self.y, self.config)
        self.assertEqual(target["scale"], 1)
        self.assertEqual(target["mean"], 7)

    def test_invalid_configuration_and_data(self):
        for changes in (
            {"patience": 0},
            {"batch_size": 0},
            {"seed": -1},
            {"learning_rate": 0},
            {"min_delta": float("nan")},
            {"max_epochs": -1},
            {"threads": 0},
            {"device": "other"},
        ):
            with self.assertRaises(ValueError):
                train(self.x, self.y, self.x, self.y, replace(self.config, **changes))
        for x, y in (
            (self.x[:0], self.y[:0]),
            (self.x * float("nan"), self.y),
            (self.x, self.y * 0),
            (self.x, self.y.flatten()),
        ):
            with self.assertRaises(ValueError):
                train(x, y, self.x, self.y, self.config)

    def test_nonfinite_loss_and_gradient(self):
        model = nn.Linear(3, 1)
        loader = [(self.x, self.y.float() * float("inf"))]
        with self.assertRaisesRegex(ValueError, "Nonfinite loss"):
            epoch_loss(model, loader, "cpu")
        hook = model.weight.register_hook(lambda g: g * float("nan"))
        with self.assertRaisesRegex(ValueError, "gradients"):
            epoch_loss(
                model, [(self.x, self.y.float())], "cpu", torch.optim.Adam(model.parameters())
            )
        hook.remove()
        # The API accepts only train and validation tensors: no test loader exists here.
        import inspect

        self.assertEqual(
            list(inspect.signature(train).parameters),
            ["train_x", "train_y", "validation_x", "validation_y", "config"],
        )
