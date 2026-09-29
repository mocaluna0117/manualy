/**
 * 取り込めるファイル形式。backend/src/storage/file-types.ts と対になっている。
 * 形式を増やすときは両方に足すこと(片方だけだとアップロードで弾かれる)。
 */
export interface FileType {
  /** 小文字の拡張子(ドット付き) */
  ext: string
  mimeType: string
  /** ブラウザのタブでそのまま開けるか。開けないものはダウンロードさせる */
  viewableInBrowser: boolean
  label: string
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
]

/** ファイル名から形式を判定する(未対応ならnull) */
export function fileTypeOf(fileName: string): FileType | null {
  const lower = fileName.toLowerCase()
  return FILE_TYPES.find((t) => lower.endsWith(t.ext)) ?? null
}

/** ファイル選択ダイアログに渡す accept 属性の値 */
export const ACCEPT_ATTR = FILE_TYPES.map((t) => t.ext).join(',')

/** 画面の説明文に出す「対応している形式」 */
export const SUPPORTED_LABEL = 'PDF / Word / Excel / PowerPoint / Outlookメール'

/**
 * 形式ごとのアイコン名(react-icons の Flat Color 一式から選ぶ)。
 * 部品側でこの名前を引いて描く。ここに置くのは、形式の情報を1箇所に集めるため
 */
export type FileIconName =
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'mail'
  | 'other'

export function fileIconOf(fileName: string): FileIconName {
  switch (fileTypeOf(fileName)?.ext) {
    case '.pdf':
      return 'pdf'
    case '.docx':
      return 'word'
    case '.xlsx':
      return 'excel'
    case '.pptx':
      return 'powerpoint'
    case '.msg':
      return 'mail'
    default:
      return 'other'
  }
}

/**
 * 一覧の「種類」列に出す拡張子(.pdf など)。
 * 未対応・拡張子なしのファイルは、実際の末尾から拾って出す
 */
export function extensionOf(fileName: string): string {
  const known = fileTypeOf(fileName)
  if (known) return known.ext
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot).toLowerCase() : ''
}

/** タイトルの初期値に使う「拡張子を落としたファイル名」 */
export function stripExtension(fileName: string): string {
  const type = fileTypeOf(fileName)
  return type ? fileName.slice(0, -type.ext.length) : fileName
}
