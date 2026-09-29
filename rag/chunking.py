def split_text(text: str, chunk_size: int = 800, overlap: int = 200) -> list[str]:
    """テキストを固定長の断片(チャンク)に分割する。

    overlap分だけ前のチャンクと重ねるのがポイント。
    チャンクの境界で文が切れても、隣のチャンクに全文が残るので
    検索時に文脈を取りこぼしにくくなる。
    """
    if chunk_size <= overlap:
        raise ValueError("chunk_sizeはoverlapより大きくすること")

    text = text.strip()
    if not text:
        return []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - overlap
    return chunks
