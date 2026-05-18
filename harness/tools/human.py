from tools import Tool


class AskHuman(Tool):
    name = "ask_human"
    description = (
        "Ask the human a question and wait for their typed reply. "
        "Use when uncertain rather than guessing."
    )
    schema = {
        "name": "ask_human",
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "Question to ask the user",
                },
            },
            "required": ["question"],
        },
    }

    def execute(self, question: str) -> str:
        print(f"\n[ask_human] {question}")
        return input("> ").strip()
