import importlib
import pkgutil
from pathlib import Path


class Tool:
    name: str
    description: str
    schema: dict

    def execute(self, **kwargs) -> str:
        raise NotImplementedError


def load_tools() -> dict[str, Tool]:
    tools: dict[str, Tool] = {}
    pkg_dir = Path(__file__).parent
    for info in pkgutil.iter_modules([str(pkg_dir)]):
        mod = importlib.import_module(f"tools.{info.name}")
        for attr in vars(mod).values():
            if isinstance(attr, type) and issubclass(attr, Tool) and attr is not Tool:
                inst = attr(); tools[inst.name] = inst
    return tools
