import { useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Popover,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import {
  LuChevronDown,
  LuChevronUp,
  LuPencil,
  LuPlus,
  LuSettings,
  LuTrash2,
} from 'react-icons/lu'
import { ME_QUERY } from '../../graphql/me'
import {
  CREATE_TEMPLATE_MUTATION,
  DELETE_TEMPLATE_MUTATION,
  REORDER_TEMPLATES_MUTATION,
  TEMPLATES_QUERY,
  UPDATE_TEMPLATE_MUTATION,
  type PromptTemplate,
} from '../../graphql/templates'
import { errorMessage, toastError } from '../../lib/toast'

interface PromptTemplateMenuProps {
  /** テンプレートを選んだとき(入力欄に本文を差し込む) */
  onSelect: (body: string) => void
  children: React.ReactNode // 開くためのボタン
}

/** 定型文の一覧。選ぶと入力欄に入る。管理者はここから編集画面を開ける */
export function PromptTemplateMenu({
  onSelect,
  children,
}: PromptTemplateMenuProps) {
  const { data } = useQuery(TEMPLATES_QUERY)
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const templates = data?.promptTemplates ?? []

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(e) => setOpen(e.open)}
        // 入力欄は画面下部にあるので上向きに開く
        positioning={{ placement: 'top-start' }}
      >
        <Popover.Trigger asChild>{children}</Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="320px">
              <Popover.Body p={2}>
                <Text fontSize="xs" color="fg.muted" px={2} pb={1}>
                  よく使う質問（クリックで入力欄に入ります）
                </Text>
                {templates.length === 0 && (
                  <Text fontSize="sm" color="fg.muted" px={2} py={2}>
                    テンプレートはまだありません
                  </Text>
                )}
                <VStack gap={0} align="stretch" maxH="320px" overflowY="auto">
                  {templates.map((template) => (
                    <Box
                      key={template.id}
                      as="button"
                      textAlign="left"
                      px={2}
                      py={2}
                      borderRadius="md"
                      _hover={{ bg: 'bg.muted' }}
                      onClick={() => {
                        onSelect(template.body)
                        setOpen(false)
                      }}
                    >
                      <Text fontSize="sm" fontWeight="medium">
                        {template.title}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                        {template.body}
                      </Text>
                    </Box>
                  ))}
                </VStack>
                {isAdmin && (
                  <Button
                    size="xs"
                    variant="ghost"
                    w="100%"
                    mt={1}
                    justifyContent="flex-start"
                    color="fg.muted"
                    onClick={() => {
                      setOpen(false)
                      setManageOpen(true)
                    }}
                  >
                    <LuSettings /> テンプレートを管理
                  </Button>
                )}
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>

      <TemplateManagerDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        templates={templates}
      />
    </>
  )
}

/** 管理者用: テンプレートの追加・編集・削除・並び替え */
function TemplateManagerDialog({
  open,
  onClose,
  templates,
}: {
  open: boolean
  onClose: () => void
  templates: PromptTemplate[]
}) {
  const refetch = { refetchQueries: ['PromptTemplates'] }
  const [createTemplate] = useMutation(CREATE_TEMPLATE_MUTATION, refetch)
  const [updateTemplate] = useMutation(UPDATE_TEMPLATE_MUTATION, refetch)
  const [deleteTemplate] = useMutation(DELETE_TEMPLATE_MUTATION, refetch)
  const [reorderTemplates] = useMutation(REORDER_TEMPLATES_MUTATION, refetch)

  // 編集中のテンプレート(idがnullなら新規追加)
  const [editing, setEditing] = useState<{
    id: string | null
    title: string
    body: string
  } | null>(null)

  const handleSave = async () => {
    if (!editing) return
    try {
      if (editing.id) {
        await updateTemplate({
          variables: {
            id: editing.id,
            title: editing.title,
            body: editing.body,
          },
        })
      } else {
        await createTemplate({
          variables: { title: editing.title, body: editing.body },
        })
      }
      setEditing(null)
    } catch (e) {
      toastError('保存できませんでした', errorMessage(e, ''))
    }
  }

  const handleDelete = async (template: PromptTemplate) => {
    if (!window.confirm(`テンプレート「${template.title}」を削除しますか？`))
      return
    await deleteTemplate({ variables: { id: template.id } })
  }

  const move = async (index: number, direction: -1 | 1) => {
    const next = [...templates]
    const target = next[index + direction]
    if (!target) return
    next[index + direction] = next[index]
    next[index] = target
    await reorderTemplates({ variables: { ids: next.map((t) => t.id) } })
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) {
          setEditing(null)
          onClose()
        }
      }}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'lg' }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>プロンプトテンプレートの管理</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {editing ? (
                <VStack gap={3} align="stretch">
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      テンプレート名（一覧に出る短い名前）
                    </Text>
                    <Input
                      autoFocus
                      value={editing.title}
                      placeholder="例: お客様対応の相談"
                      onChange={(e) =>
                        setEditing({ ...editing, title: e.target.value })
                      }
                    />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      本文（入力欄に入る文章）
                    </Text>
                    <Textarea
                      rows={4}
                      value={editing.body}
                      placeholder="例: お客様から「〇〇」という連絡がありました。どのように対応すればよいですか？"
                      onChange={(e) =>
                        setEditing({ ...editing, body: e.target.value })
                      }
                    />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      「〇〇」と書いておくと、挿入時にその部分が選択され、すぐ書き換えられます
                    </Text>
                  </Box>
                  <HStack justify="flex-end">
                    <Button variant="outline" onClick={() => setEditing(null)}>
                      キャンセル
                    </Button>
                    <Button colorPalette="blue" onClick={() => void handleSave()}>
                      保存
                    </Button>
                  </HStack>
                </VStack>
              ) : (
                <VStack gap={2} align="stretch">
                  {templates.map((template, i) => (
                    <HStack
                      key={template.id}
                      gap={2}
                      p={2}
                      borderWidth="1px"
                      borderRadius="md"
                      align="flex-start"
                    >
                      <VStack gap={0}>
                        <IconButton
                          aria-label="上へ"
                          size="2xs"
                          variant="ghost"
                          disabled={i === 0}
                          onClick={() => void move(i, -1)}
                        >
                          <LuChevronUp />
                        </IconButton>
                        <IconButton
                          aria-label="下へ"
                          size="2xs"
                          variant="ghost"
                          disabled={i === templates.length - 1}
                          onClick={() => void move(i, 1)}
                        >
                          <LuChevronDown />
                        </IconButton>
                      </VStack>
                      <Box flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">
                          {template.title}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          {template.body}
                        </Text>
                      </Box>
                      <IconButton
                        aria-label="編集"
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        onClick={() => setEditing({ ...template })}
                      >
                        <LuPencil />
                      </IconButton>
                      <IconButton
                        aria-label="削除"
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        _hover={{ color: 'fg.error' }}
                        onClick={() => void handleDelete(template)}
                      >
                        <LuTrash2 />
                      </IconButton>
                    </HStack>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => setEditing({ id: null, title: '', body: '' })}
                  >
                    <LuPlus /> テンプレートを追加
                  </Button>
                </VStack>
              )}
            </Dialog.Body>

            <Dialog.Footer>
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
