/**
 * 取り込めるファイル形式の一覧。
 *
 * ここが唯一の決定版。アップロードの受け入れ・署名付きURLのContent-Type・
 * 画面での扱い(ブラウザで開けるか)を、すべてこの表から決める。
 * 形式を増やすときはここに1行足し、RAG側(rag/extract.py)に抽出処理を足す。
 */
export interface FileType {
  /** 小文字の拡張子(ドット付き) */
  ext: string;
  mimeType: string;
  /** ブラウザのタブでそのまま開けるか。開けないものはダウンロードさせる */
  viewableInBrowser: boolean;
  /** 画面に出す形式名 */
  label: string;
}

export const FILE_TYPES: FileType[] = [
  {
    ext: '.pdf',
    mimeType: 'application/pdf',
    viewableInBrowser: true,
    label: 'PDF',
  },
  {
    ext: '.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    viewableInBrowser: false,
    label: 'Word',
  },
  {
    ext: '.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    viewableInBrowser: false,
    label: 'Excel',
  },
  {
    ext: '.pptx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    viewableInBrowser: false,
    label: 'PowerPoint',
  },
  {
    ext: '.msg',
    mimeType: 'application/vnd.ms-outlook',
    viewableInBrowser: false,
    label: 'Outlookメール',
  },
];

/** ファイル名から形式を判定する(未対応ならnull) */
export function fileTypeOf(fileName: string): FileType | null {
  const lower = fileName.toLowerCase();
  return FILE_TYPES.find((t) => lower.endsWith(t.ext)) ?? null;
}

/** 署名付きURLに載せるContent-Type(不明なものは汎用のバイナリ扱い) */
export function mimeTypeOf(fileName: string): string {
  return fileTypeOf(fileName)?.mimeType ?? 'application/octet-stream';
}

/** 画面の説明文に出す「対応している形式」 */
export const SUPPORTED_EXTENSIONS = FILE_TYPES.map((t) => t.ext).join(', ');
