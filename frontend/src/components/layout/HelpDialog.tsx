import { useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Image,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from '@chakra-ui/react'
import type { IconType } from 'react-icons'
import {
  LuBot,
  LuChartNoAxesColumn,
  LuFileImage,
  LuFolderTree,
  LuLifeBuoy,
  LuMessageCircleQuestion,
  LuNotebookPen,
  LuSearch,
  LuSettings,
  LuUpload,
  LuUsers,
} from 'react-icons/lu'
import { ME_QUERY } from '../../graphql/me'
import imgChatAnswer from '../../assets/help/chat-answer.png'
import imgChatHome from '../../assets/help/chat-home.png'
import imgChatTemplates from '../../assets/help/chat-templates.png'
import imgContextMenu from '../../assets/help/context-menu.png'
import imgExplorerDetails from '../../assets/help/explorer-details.png'
import imgExplorerRoot from '../../assets/help/explorer-root.png'
import imgSettings from '../../assets/help/settings.png'
import imgUploadDialog from '../../assets/help/upload-dialog.png'

interface HelpDialogProps {
  open: boolean
  onClose: () => void
  /** 画像つきのガイドPDFを開く(ビューアはダイアログの外なので閉じてから呼ぶ) */
  onOpenPdf: () => void
}

interface HelpItem {
  label: string
  body: string
  /** 実際の画面のスクリーンショット(PDF版と同じもの) */
  image?: string
  imageCaption?: string
}

interface HelpSection {
  title: string
  icon: IconType
  adminOnly?: boolean
  items: HelpItem[]
}

// 使い方の本文。実装を変えたら必ずここも更新する
// (PDF版はdocs/usage-guide/index.html。両方を揃えること)
const SECTIONS: HelpSection[] = [
  {
    title: 'AIに質問する（チャット）',
    icon: LuMessageCircleQuestion,
    items: [
      {
        label: '質問のしかた',
        image: imgChatHome,
        imageCaption: '入力欄に質問を書いて、右の矢印ボタンで送ります',
        body: '入力欄に知りたいことを書いて送るだけです。例:「クイックパーツマニュアルを見せて」「床鳴りの対応手順は？」。話し言葉のままで大丈夫です。回答は書き上がるそばから流れて出ます。',
      },
      {
        label: '回答の根拠からマニュアルを開く',
        image: imgChatAnswer,
        imageCaption: '青い枠が絞り込みの選択肢、下のカードが根拠マニュアルです',
        body: '回答の下に根拠マニュアルのカードが出ます。マニュアル名や「p.3」のようなページボタンを押すと、該当ページが直接開きます（スマートフォンでは別のタブで開きます）。',
      },
      {
        label: '絞り込みの選択肢',
        body: 'AIが選択肢ボタンを出したら、当てはまるものをクリックするだけで答えられます。当てはまらなければ「その他」欄に自由に入力してください。',
      },
      {
        label: 'よく使う質問（テンプレート）',
        image: imgChatTemplates,
        imageCaption: '入力欄左の吹き出しアイコンから選べます',
        body: '入力欄左の吹き出しアイコンから定型文を選べます。「〇〇」の部分が選択状態で入るので、そのまま打ち替えれば完成です。',
      },
      {
        label: '画像で質問する',
        body: '画像アイコンから、または画面を撮ってそのまま貼り付け（Ctrl+V / ⌘V）で添付できます。4枚まで（PNG/JPEG/WebP/GIF、1枚4MBまで）。サムネイルを押すと拡大して確認でき、角の×で1枚ずつ取り消せます。文章なしで画像だけでも質問できます。',
      },
      {
        label: '回答の評価（👍 / 👎）',
        body: '回答の右下の👍/👎で、役に立ったかどうかを伝えられます。👎のときは理由（マニュアルが無い・内容が古い・欲しい答えと違う）も選べます。この評価は「足りないマニュアル」を見つけるために使われます。もう一度押すと取り消せます。',
      },
      {
        label: '停止・編集して再送信',
        body: '生成中は「停止」ボタンで中断できます。送信済みの質問は鉛筆アイコンで入力欄に戻し、書き直して再送信できます。',
      },
      {
        label: 'コピー',
        body: '吹き出し右下のコピーアイコンで本文全体をコピーできます。メール文例などの枠には右上に専用の「コピー」ボタンがあり、その部分だけを取り出せます。',
      },
    ],
  },
  {
    title: 'マニュアルを探す・読む',
    icon: LuSearch,
    items: [
      {
        label: 'キーワード検索',
        body: 'サイドバーの「マニュアル名・内容で検索」にキーワードを入れてEnter。タイトルと本文の両方を検索し、一致箇所がハイライトされます。',
      },
      {
        label: 'フォルダから探す',
        image: imgExplorerRoot,
        imageCaption: 'フォルダの一覧。ダブルクリックで中に入れます',
        body: 'サイドバーの「マニュアル」でエクスプローラーが開きます。フォルダやマニュアルはダブルクリックで開きます（1回クリックは選択）。スマートフォンでは1回タップで開きます。',
      },
      {
        label: '表示の切り替え・並べ替え',
        image: imgExplorerDetails,
        imageCaption: '詳細表示。「種類」「更新日」などのヘッダーで並べ替えできます',
        body: '一覧右上のボタンで「詳細」と「中アイコン」を切り替えられます。詳細表示では「名前」「種類」「更新日」「サイズ」のヘッダーで並べ替えできます。ファイル形式ごとのアイコンが付くので、PDFとExcelを見分けられます。',
      },
      {
        label: 'まとめてダウンロード',
        body: 'チェックボックスで選んで「ダウンロード」を押すと、1件ならそのまま、複数ならZIPにまとめて保存できます。フォルダごと選ぶこともできます。',
      },
      {
        label: 'マニュアルの状態',
        body: '名前の横のオレンジの時計は「取り込み中」（AI検索にまだ出ません）、赤い三角は「取り込み失敗」です。何も付いていなければ検索できる状態です。',
      },
    ],
  },
  {
    title: '画面の調整',
    icon: LuSettings,
    items: [
      {
        label: '設定',
        image: imgSettings,
        imageCaption: '',
        body: 'サイドバー下部の「設定」から、送信キー（Enterで送信 / Shift+Enterで送信）、配色（端末に合わせる・ライト・ダーク）、画面の並び（左に1枚 / チャット左 / マニュアル左）を変えられます。スマートフォンでは送信キーと並びの設定は出ません。',
      },
      {
        label: 'サイドバー',
        body: '端をドラッグすると幅を調整でき、上部のパネルアイコンで折りたためます。「チャット履歴」「マニュアル」の見出しを押すと、それぞれを畳めます。設定はブラウザに記憶されます。',
      },
      {
        label: 'スマートフォン',
        body: '左端から画面のどこでも横にスワイプするとサイドバーが開きます（もう一度スワイプで閉じます）。右上のボタンで、サイドバーを開かずに新しいチャットを始められます。ホーム画面に追加するとアプリのように使えます。',
      },
    ],
  },
  {
    title: '困ったとき',
    icon: LuLifeBuoy,
    items: [
      {
        label: '見つからないとき',
        body: '言い方を変えて聞き直すか、キーワード検索も試してください。回答に👎を付けておくと、管理者が「足りないマニュアル」として気づけます。',
      },
      {
        label: '問い合わせ',
        body: 'サイドバー下部の「問い合わせ」から、不具合の報告・使い方の質問・追加してほしいマニュアルなどを管理者へ送れます。画面の写真を5枚まで添付でき、貼り付け（Ctrl+V / ⌘V）でも添えられます。書きかけの内容は閉じても残ります（再読み込みで消えます）。',
      },
    ],
  },
  {
    title: 'マニュアルの追加・管理',
    icon: LuUpload,
    adminOnly: true,
    items: [
      {
        label: 'アップロード',
        image: imgUploadDialog,
        imageCaption: '',
        body: '「マニュアルを追加」からファイルをドラッグ&ドロップ（複数可）。PDFのほかWord・Excel・PowerPoint・Outlookメール(.msg)にも対応しています。カテゴリは「AIにおまかせ」が既定で、内容を読んで自動で振り分けます（合うフォルダが無ければ作成）。取り込みが終わると、どのフォルダに入ったかが1件ずつ表示されます。',
      },
      {
        label: 'いま上げた分だけをAIで分類',
        body: 'アップロードが終わると「いま上げた◯件だけをAIで分類」が出ます。「AIにおまかせ」が1件ずつ判断するのに対し、こちらは上げた分をまとめて見て分類するので、関連する資料が同じフォルダにまとまりやすくなります。ほかのマニュアルは動きません（ピン留めしたものと鍵付きフォルダの中のものも動きません）。読み取りが終わるまで待ってから押せるようになります。',
      },
      {
        label: '同名ファイルの差し替え',
        body: '同名のファイルをアップロードすると、更新日が新しい方だけが残ります。古い方を上げてしまってもスキップされるので安心です。',
      },
      {
        label: '名前の変更',
        body: '右クリック →「名前を変更」でマニュアル名を変えられます。名前もAI検索の手がかりに使っているため、変更すると裏側で検索用のデータも作り直されます。',
      },
      {
        label: '再取り込み・削除',
        body: '取り込みに失敗したマニュアルは右クリック →「再取り込み」でやり直せます。削除するとゴミ箱に入り、サイドバーの「ゴミ箱」から元に戻せます。',
      },
    ],
  },
  {
    title: 'フォルダと分類',
    icon: LuFolderTree,
    adminOnly: true,
    items: [
      {
        label: 'フォルダの管理',
        body: 'サイドバーの「＋」で作成、鉛筆で名前変更、ゴミ箱で削除。削除すると中のマニュアルも一緒にゴミ箱へ移り、あとで元に戻せます。フォルダ自体をドラッグすると並び替えられます。',
      },
      {
        label: '管理者だけに表示するフォルダ',
        body: '作成時のチェック、または鍵ボタンで「管理者だけに表示する」に切り替えられます。中のマニュアルは一般の利用者の一覧・検索・ダウンロードに出ません。AIの回答の根拠にも使われません（管理者が質問した場合も含みます。業務と関係のない資料が回答に混ざらないようにするためです）。管理者は一覧やキーワード検索から開いて読めます。',
      },
      {
        label: 'マニュアルの移動',
        body: 'マニュアルをドラッグして一覧またはサイドバーのフォルダへドロップします。「未分類」に落とすと分類を外せます。',
      },
      {
        label: '鍵付きフォルダとAIの分類',
        body: 'AIの分類は、鍵付きフォルダを「行き先」として使えます（チャットで「〇〇を△△フォルダに入れて」と頼めます）。逆に、鍵付きフォルダの中にあるマニュアルはAIの分類では動かしません。AIが鍵の外へ出すと、隠していた資料が全員に見えてしまうためです。鍵付きから出したいときは、一覧でドラッグするか、チャットで1件ずつ移動を指示してください。なお、アップロード時の「AIにおまかせ」だけは鍵付きフォルダを行き先にしません（分類が終わるのが数分後になることがあり、鍵付きへ入ったことをお伝えできないためです）。',
      },
      {
        label: 'ピン留め',
        image: imgContextMenu,
        imageCaption: 'マニュアルを右クリックすると出るメニュー',
        body: '右クリック →「ピン留め」で、AIの再分類から保護できます（手動の判断を守る仕組み）。ピンの付け外しは手動のみです。',
      },
      {
        label: 'AIで再分類',
        body: 'サイドバーのロボットアイコンで全マニュアルをAIが分類し直します（数分かかります。ピン留めは動きません）。選んだファイルだけ・未分類だけを対象にするボタンは一覧のツールバーにあります。再分類で空になったフォルダは、終わったあとに片付けるか選べます。',
      },
      {
        label: '再分類を元に戻す',
        body: '再分類の結果が思っていたのと違ったときは、一覧の上に出る「直前の再分類（N件）を元に戻す」で前の分類に戻せます。再分類のあとに手で動かしたファイルはそのままにするので、あとからの手直しが取り消されることはありません。',
      },
      {
        label: '分類の判断待ち',
        body: '分類ルールが2つ以上当てはまって行き先が決まらないファイルは、AIが勝手に決めずに元の場所のまま保留にします（例:「クロゼット関連は建具・内装対応へ」と「※〇〇と併用する と書かれたものは共通アフター対応マニュアルへ」の両方に当てはまるとき）。一覧の上に出る「分類の判断待ち（N件）」から行き先を選んでください。チャットで再分類した場合は、会話の中で1件ずつ選択肢が出ます。選ぶまで動かないので、後回しにしても分類が崩れることはありません。',
      },
      {
        label: '分類ルール',
        body: 'サイドバーの定規アイコンから、AIに教える分類の決まりごとを登録できます（例:「床暖房関連はフローリング関連に入れる」）。アップロード時の自動分類と再分類の両方に適用されます。',
      },
    ],
  },
  {
    title: 'チャットでの管理操作',
    icon: LuBot,
    adminOnly: true,
    items: [
      {
        label: 'フォルダの作成',
        body: '「〇〇というフォルダを作って」ですぐに作成されます。「鍵付きにして」「管理者だけに見せて」と添えると、管理者だけに表示するフォルダになります。',
      },
      {
        label: 'フォルダの名前変更・削除',
        body: '「〇〇フォルダの名前を△△に変えて」で名前を変更できます（作り直しではないので中身はそのまま）。「〇〇フォルダを削除して」でゴミ箱へ移せます。既にあるフォルダを「鍵付きにして」と頼むこともできます。',
      },
      {
        label: '1件だけ移動',
        body: '「〇〇のマニュアルを△△に移して」で、そのマニュアルを今すぐ移動します。名前が曖昧なときは候補が出るので選び直してください。',
      },
      {
        label: '今後の方針を教える',
        body: '「今後〜は〜に分類して」は分類ルールとして保存され、次回の分類から効きます（その場では動きません）。',
      },
      {
        label: '全件の再分類',
        body: '「全マニュアルを再分類して」と頼むと確認ボタンが出ます。実行すると数分かかり、完了すると同じ会話に結果が届きます。分類ルールが食い違って行き先が決まらないファイルは、そのあと1件ずつ選択肢で聞かれます。',
      },
      {
        label: '再分類を元に戻す',
        body: '「直前の再分類を元に戻す」と頼むとボタンが出ます。押すと前の分類に戻ります（再分類のあとに手で動かしたファイルはそのままです）。',
      },
    ],
  },
  {
    title: '利用状況を見る',
    icon: LuChartNoAxesColumn,
    adminOnly: true,
    items: [
      {
        label: '答えられなかった質問',
        body: '利用者が👎を押した質問と、AIが「マニュアルに根拠が無い」と判断した質問が並びます。ここに出てくる内容が、次に用意すべきマニュアルの候補です。',
      },
      {
        label: 'マニュアルの下書きを作る',
        body: '答えられなかった質問の「この質問から下書きを作る」を押すと、関連する既存資料を材料にAIが章立てと本文案を書きます。分からないことは「(要確認)」として空けてあるので、そこを埋めて清書してください。その場で手直しでき、コピーまたは.mdで保存できます。',
      },
      {
        label: 'よく聞かれること',
        body: '「AIでまとめる」を押すと、言い回しが違うだけの質問をAIがテーマごとにまとめて数えます。多いものはテンプレートに登録しておくと、毎回入力せずに済みます。',
      },
      {
        label: 'マニュアルの使われ方',
        body: '回答の根拠として使われた回数が見られます。0回が続くマニュアルは、内容が古い・探しにくい・そもそも不要、のいずれかを疑えます。',
      },
    ],
  },
  {
    title: 'ユーザー管理',
    icon: LuUsers,
    adminOnly: true,
    items: [
      {
        label: '招待・権限・削除',
        body: 'サイドバーの「ユーザー管理」から、メールアドレスで招待（仮パスワード付きの招待メールが届きます）、一般/管理者の切り替え、削除ができます。',
      },
      {
        label: 'まとめて招待する',
        body: '入力欄に改行・カンマ・スペース区切りで並べると、最大30件を一度に招待できます。全員へ同時に送られるので、届く時刻が人によってばらけません。既に登録済みなど送れなかった宛先だけが入力欄に残り、理由が表示されるので、直してもう一度送れます。',
      },
    ],
  },
  {
    title: 'テンプレートの管理',
    icon: LuNotebookPen,
    adminOnly: true,
    items: [
      {
        label: 'よく使う質問を育てる',
        body: 'チャットのテンプレート一覧の下の「テンプレートを管理」から追加・編集・削除・並び替えができます。本文に「〇〇」を入れておくと、挿入時にその部分が選択状態になります。',
      },
    ],
  },
]

/** 使い方ガイド。管理者には管理機能の説明も表示する */
export function HelpDialog({ open, onClose, onOpenPdf }: HelpDialogProps) {
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const sections = SECTIONS.filter((s) => isAdmin || !s.adminOnly)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'lg' }}
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>使い方ガイド</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack gap={6} align="stretch">
                {sections.map((section) => (
                  <Box key={section.title}>
                    <HStack gap={2} mb={2}>
                      <Box color="blue.fg">
                        <section.icon />
                      </Box>
                      <Text fontWeight="bold">{section.title}</Text>
                      {section.adminOnly && (
                        <Badge colorPalette="purple" size="sm">
                          管理者のみ
                        </Badge>
                      )}
                    </HStack>
                    <VStack gap={2} align="stretch" pl={6}>
                      {section.items.map((item) => (
                        <Box key={item.label}>
                          <Text fontSize="sm" fontWeight="medium">
                            {item.label}
                          </Text>
                          <Text fontSize="sm" color="fg.muted">
                            {item.body}
                          </Text>
                          {item.image && (
                            <Box mt={2} mb={1}>
                              <Image
                                src={item.image}
                                alt={item.imageCaption || item.label}
                                borderWidth="1px"
                                borderStyle="solid"
                                borderColor="border"
                                rounded="md"
                                w="100%"
                              />
                              {item.imageCaption && (
                                <Text fontSize="xs" color="fg.subtle" mt={1}>
                                  {item.imageCaption}
                                </Text>
                              )}
                            </Box>
                          )}
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                ))}
                <Text fontSize="xs" color="fg.subtle">
                  印刷や共有には、下の「PDF版を開く」が便利です。
                  チャットで「使い方を教えて」と聞いても、このガイドの内容をAIが案内します。
                </Text>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer justifyContent="space-between">
              <Button
                colorPalette="blue"
                variant="subtle"
                onClick={() => {
                  onClose()
                  onOpenPdf()
                }}
              >
                <LuFileImage /> PDF版を開く
              </Button>
              <Button variant="outline" onClick={onClose}>
                閉じる
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
