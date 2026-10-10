"""Standalone GBrain memory provider for Hermes Agent."""

from .provider import GBrainMemoryProvider


def register(ctx):
    ctx.register_memory_provider(GBrainMemoryProvider())
