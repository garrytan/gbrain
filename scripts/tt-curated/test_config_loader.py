#!/usr/bin/env python3
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config_loader


def test_load_config_shows_bootstrap_hint_when_config_is_missing(tmp_path, monkeypatch):
    missing = tmp_path / 'config.yaml'
    example = tmp_path / 'config.example.yaml'
    example.write_text('paths: {}\n')
    monkeypatch.setattr(config_loader, 'CONFIG_PATH', missing)
    monkeypatch.setattr(config_loader, 'EXAMPLE_CONFIG_PATH', example)

    with pytest.raises(RuntimeError, match=r'cp .*config\.example\.yaml .*config\.yaml'):
        config_loader.load_config()


def test_load_config_shows_parse_hint_for_invalid_yaml(tmp_path, monkeypatch):
    broken = tmp_path / 'config.yaml'
    broken.write_text('paths: [broken\n')
    example = tmp_path / 'config.example.yaml'
    example.write_text('paths: {}\n')
    monkeypatch.setattr(config_loader, 'CONFIG_PATH', broken)
    monkeypatch.setattr(config_loader, 'EXAMPLE_CONFIG_PATH', example)

    with pytest.raises(RuntimeError, match='Invalid YAML'):
        config_loader.load_config()
