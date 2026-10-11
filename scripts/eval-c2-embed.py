"""Embed the C2 candidate-fusion fixture texts with a free local model (no API key, no spend).

usage: python3 scripts/eval-c2-embed.py <texts.json> <out.json.gz>

<texts.json> is the output of `bun scripts/eval-c2-candidate-fusion.ts texts`. Vectors are
L2-normalized, then stored as int8 with a per-vector scale, keyed by sha256(text). Requires
`pip install fastembed==0.8.1` (ONNX runtime; downloads the model once).
"""
import base64, gzip, hashlib, json, sys

import numpy as np
from fastembed import TextEmbedding

MODEL = "BAAI/bge-small-en-v1.5"

def main(src: str, dst: str) -> None:
    spec = json.load(open(src))
    texts = spec["texts"]
    vecs = np.array(list(TextEmbedding(MODEL).embed(texts)), dtype=np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    out = {}
    for text, v in zip(texts, vecs):
        scale = float(np.abs(v).max()) / 127.0
        q = np.clip(np.round(v / scale), -127, 127).astype(np.int8)
        out[hashlib.sha256(text.encode()).hexdigest()] = {"s": scale, "q": base64.b64encode(q.tobytes()).decode()}
    payload = {"model": MODEL, "dims": int(vecs.shape[1]), "texts_sha256": spec["texts_sha256"], "vectors": out}
    with gzip.GzipFile(dst, "wb", mtime=0) as f:
        f.write(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
