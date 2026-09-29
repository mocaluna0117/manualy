"""Bedrockクライアントの生成を1か所にまとめる。

タイムアウトを明示しないと、AWS側が応答しないときに接続が延々ぶら下がり、
呼び出し元(backend→rag)も一緒に詰まる。リトライも明示して一時的な
スロットリング(ThrottlingException)から自動回復させる。
"""

import os


def create_bedrock_client(region: str, read_timeout: int = 60):
    import boto3  # type: ignore[import-untyped]
    from botocore.config import Config  # type: ignore[import-untyped]

    return boto3.client(
        "bedrock-runtime",
        region_name=region,
        config=Config(
            connect_timeout=int(os.environ.get("BEDROCK_CONNECT_TIMEOUT", 10)),
            read_timeout=int(os.environ.get("BEDROCK_READ_TIMEOUT", read_timeout)),
            # adaptiveは待ち時間を自動調整してスロットリングに強い
            retries={"max_attempts": 3, "mode": "adaptive"},
        ),
    )
