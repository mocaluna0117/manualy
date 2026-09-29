import { Button, Dialog, Input, Portal, Text, VStack } from '@chakra-ui/react'
import { useState, type ReactNode } from 'react'
import { LuColumns2, LuMonitor, LuMoon, LuSun } from 'react-icons/lu'
import { USE_SUPABASE_AUTH, authErrorMessage } from '../../lib/auth'
import {
  setLayoutMode,
  setSendKey,
  setThemeMode,
  useLayoutMode,
  useSendKey,
  useThemeMode,
  type LayoutMode,
  type ThemeMode,
} from '../../lib/settings'
import { supabaseClient } from '../../lib/supabase'
import { toastError, toastSuccess } from '../../lib/toast'
import { useIsTouchDevice } from '../../lib/useIsTouchDevice'

const LAYOUT_OPTIONS: { value: LayoutMode; label: string; hint: string }[] = [
  {
    value: 'single',
    label: '左に1枚',
    hint: 'チャットとマニュアルを左サイドバーにまとめる',
  },
  {
    value: 'chat-left',
    label: 'チャット左・マニュアル右',
    hint: '2枚に分けて表示する',
  },
  {
    value: 'chat-right',
    label: 'マニュアル左・チャット右',
    hint: '2枚に分けて表示する',
  },
]

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactNode }[] = [
  { value: 'system', label: '端末の設定に合わせる', icon: <LuMonitor /> },
  { value: 'light', label: 'ライト（明るい）', icon: <LuSun /> },
  { value: 'dark', label: 'ダーク（暗い）', icon: <LuMoon /> },
]

/**
 * パスワードの最低文字数。**Supabase側の設定と同じ値にしておく。**
 * 実機で9文字を送ると 422 weak_password で弾かれた。ここで先に止めないと、
 * 押してから英語のエラーが返ってくることになる
 */
const MIN_PASSWORD_LENGTH = 10

/**
 * パスワードの変更欄(Supabase方式のときだけ出す)。
 *
 * 切り替え当日は全員が仮パスワードから自分のものへ変える。
 * これが画面に無いと、その運用そのものが成り立たない。
 * Cognitoの頃はHosted UIに同じ画面があったので、アプリ側には無かった
 */
function PasswordSection() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  // 打ち終わる前から赤くしても急かすだけなので、入力が始まってから出す
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit =
    !saving && password.length >= MIN_PASSWORD_LENGTH && password === confirm

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const { error } = await supabaseClient().auth.updateUser({ password })
      if (error) {
        toastError('パスワードを変更できませんでした', authErrorMessage(error))
        return
      }
      // 入れたままにすると、次に開いたときに古い入力が残って紛らわしい
      setPassword('')
      setConfirm('')
      toastSuccess(
        'パスワードを変更しました',
        '次からは新しいパスワードでサインインしてください',
      )
    } catch (e) {
      toastError('パスワードを変更できませんでした', authErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Text fontSize="sm" fontWeight="medium" mt={6} mb={2}>
        パスワードの変更
      </Text>
      <VStack gap={2} align="stretch">
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={`新しいパスワード（${MIN_PASSWORD_LENGTH}文字以上）`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="確認のためもう一度"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing)
              void handleSubmit()
          }}
        />
        {tooShort && (
          <Text fontSize="xs" color="fg.error">
            {MIN_PASSWORD_LENGTH}文字以上にしてください
          </Text>
        )}
        {mismatch && (
          <Text fontSize="xs" color="fg.error">
            2つの入力が一致していません
          </Text>
        )}
        {/* 実機で確認した挙動。黙って他の端末が切れると
            「勝手にログアウトされた」と受け取られる */}
        <Text fontSize="xs" color="fg.muted">
          変更すると、他の端末やブラウザのログインは切れます。この端末はそのまま使えます。
        </Text>
        <Button
          colorPalette="blue"
          disabled={!canSubmit}
          loading={saving}
          onClick={() => void handleSubmit()}
        >
          パスワードを変更する
        </Button>
      </VStack>
    </>
  )
}

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

/** アプリの設定ダイアログ(配色・チャットの送信キー・パスワードの変更) */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const sendKey = useSendKey()
  const themeMode = useThemeMode()
  const layoutMode = useLayoutMode()
  // 指で操作する端末では意味を持たない設定は出さない。
  // 画面の並びは1枚しか表示せず、送信キーもソフトキーボードには
  // Shift+Enterが無く、送信はボタンで行うため
  const isTouch = useIsTouchDevice()

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>設定</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {!isTouch && (
                <>
              <Text fontSize="sm" fontWeight="medium" mb={2}>
                画面の並び
              </Text>
              <VStack gap={2} align="stretch" mb={6}>
                {LAYOUT_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={layoutMode === option.value ? 'solid' : 'outline'}
                    colorPalette="blue"
                    justifyContent="flex-start"
                    h="auto"
                    py={2}
                    onClick={() => setLayoutMode(option.value)}
                  >
                    <LuColumns2 />
                    <VStack gap={0} align="start">
                      <Text>{option.label}</Text>
                      <Text
                        fontSize="xs"
                        opacity={0.8}
                        fontWeight="normal"
                      >
                        {option.hint}
                      </Text>
                    </VStack>
                  </Button>
                ))}
              </VStack>
                </>
              )}

              <Text fontSize="sm" fontWeight="medium" mb={2}>
                配色（テーマ）
              </Text>
              <VStack gap={2} align="stretch" mb={6}>
                {THEME_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={themeMode === option.value ? 'solid' : 'outline'}
                    colorPalette="blue"
                    justifyContent="flex-start"
                    onClick={() => setThemeMode(option.value)}
                  >
                    {option.icon} {option.label}
                  </Button>
                ))}
              </VStack>

              {!isTouch && (
                <>
                  <Text fontSize="sm" fontWeight="medium" mb={2}>
                    メッセージの送信キー
                  </Text>
                  <VStack gap={2} align="stretch">
                    <Button
                      variant={sendKey === 'enter' ? 'solid' : 'outline'}
                      colorPalette="blue"
                      justifyContent="flex-start"
                      onClick={() => setSendKey('enter')}
                    >
                      Enter で送信（Shift+Enter で改行）
                    </Button>
                    <Button
                      variant={sendKey === 'shift-enter' ? 'solid' : 'outline'}
                      colorPalette="blue"
                      justifyContent="flex-start"
                      onClick={() => setSendKey('shift-enter')}
                    >
                      Enter で改行（Shift+Enter で送信）
                    </Button>
                  </VStack>
                </>
              )}

              {/* Cognito方式のビルドではHosted UI側に同じ画面があるので出さない */}
              {USE_SUPABASE_AUTH && <PasswordSection />}
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
