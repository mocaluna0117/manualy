import { useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu'
import {
  CREATE_RULE_MUTATION,
  DELETE_RULE_MUTATION,
  RULES_QUERY,
  UPDATE_RULE_MUTATION,
  type ClassificationRule,
} from '../../graphql/rules'
import { errorMessage, toastError } from '../../lib/toast'

interface ClassificationRuleDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * 分類ルールの管理(ADMIN専用)。
 * チャットからも登録できるが、AIがツールを呼び忘れると保存されないことがある。
 * ここは確実に反映される経路として用意している
 */
export function ClassificationRuleDialog({
  open,
  onClose,
}: ClassificationRuleDialogProps) {
  const { data, loading } = useQuery(RULES_QUERY, { skip: !open })
  const refetch = { refetchQueries: ['ClassificationRules'] }
  const [createRule] = useMutation(CREATE_RULE_MUTATION, refetch)
  const [updateRule] = useMutation(UPDATE_RULE_MUTATION, refetch)
  const [deleteRule] = useMutation(DELETE_RULE_MUTATION, refetch)

  const [newText, setNewText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  )
  const rules = data?.classificationRules ?? []

  const handleCreate = async () => {
    const text = newText.trim()
    if (!text) return
    try {
      await createRule({ variables: { text } })
      setNewText('')
    } catch (e) {
      toastError('追加できませんでした', errorMessage(e, ''))
    }
  }

  const handleUpdate = async () => {
    if (!editing) return
    try {
      await updateRule({
        variables: { id: editing.id, text: editing.text.trim() },
      })
      setEditing(null)
    } catch (e) {
      toastError('保存できませんでした', errorMessage(e, ''))
    }
  }

  const handleDelete = async (rule: ClassificationRule) => {
    if (!window.confirm(`分類ルール「${rule.text}」を削除しますか？`)) return
    await deleteRule({ variables: { id: rule.id } })
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
              <Dialog.Title>分類ルール</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="sm" color="fg.muted" mb={3}>
                マニュアルを自動分類するときの決まりごとです。アップロード時の
                自動分類と、全体の再分類のどちらにも適用されます。
              </Text>

              {loading && <Spinner size="sm" />}
              {!loading && rules.length === 0 && (
                <Text fontSize="sm" color="fg.muted" mb={3}>
                  まだ登録されていません。
                </Text>
              )}

              <VStack gap={2} align="stretch" mb={4}>
                {rules.map((rule) =>
                  editing?.id === rule.id ? (
                    <HStack key={rule.id} gap={2}>
                      <Input
                        autoFocus
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ ...editing, text: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                            void handleUpdate()
                          if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                      <Button size="sm" onClick={() => void handleUpdate()}>
                        保存
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </Button>
                    </HStack>
                  ) : (
                    <HStack
                      key={rule.id}
                      gap={2}
                      p={2}
                      borderWidth="1px"
                      borderRadius="md"
                    >
                      <Box flex="1" minW={0}>
                        <Text fontSize="sm" overflowWrap="anywhere">
                          {rule.text}
                        </Text>
                      </Box>
                      <IconButton
                        aria-label="編集"
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        onClick={() =>
                          setEditing({ id: rule.id, text: rule.text })
                        }
                      >
                        <LuPencil />
                      </IconButton>
                      <IconButton
                        aria-label="削除"
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        _hover={{ color: 'fg.error' }}
                        onClick={() => void handleDelete(rule)}
                      >
                        <LuTrash2 />
                      </IconButton>
                    </HStack>
                  ),
                )}
              </VStack>

              <HStack gap={2}>
                <Input
                  placeholder="例: 床暖房関連はフローリング関連に入れる"
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                      void handleCreate()
                  }}
                />
                <Button
                  colorPalette="blue"
                  disabled={!newText.trim()}
                  onClick={() => void handleCreate()}
                >
                  <LuPlus /> 追加
                </Button>
              </HStack>
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
