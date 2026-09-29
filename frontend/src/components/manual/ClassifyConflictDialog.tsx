import { useMutation, useQuery } from "@apollo/client/react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { LuScale } from "react-icons/lu";
import { errorMessage, toastError, toastSuccess } from "../../lib/toast";
import {
  CLASSIFY_CONFLICTS_QUERY,
  RESOLVE_CONFLICT_MUTATION,
} from "../../graphql/manuals";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 解決したあとに一覧を取り直す */
  onResolved: () => void;
}

/**
 * 分類ルールが食い違ったファイルの行き先を選ぶ(ADMIN専用)。
 *
 * 例:「クロゼット関連は建具・内装対応へ」と「※〇〇と併用する と書かれた
 * ものは共通アフター対応マニュアルへ」の両方に当てはまるファイル。
 * どちらが正しいかは運用の判断なので、AIには決めさせずここで選んでもらう。
 * 選ぶまでは今のフォルダのまま動かしていない。
 */
export function ClassifyConflictDialog({ open, onClose, onResolved }: Props) {
  const { data, loading, refetch } = useQuery(CLASSIFY_CONFLICTS_QUERY, {
    skip: !open,
    fetchPolicy: "cache-and-network",
  });
  const [resolve, { loading: saving }] = useMutation(RESOLVE_CONFLICT_MUTATION);

  const conflicts = data?.pendingClassifyConflicts ?? [];

  const choose = async (manualId: string, category: string | null) => {
    try {
      const { data: res } = await resolve({
        variables: { manualId, category },
      });
      const r = res?.resolveClassifyConflict;
      toastSuccess(
        r?.movedTo ? `「${r.movedTo}」に入れました` : "今のままにしました",
        r && r.remaining > 0 ? `残り${r.remaining}件` : "すべて片付きました",
      );
      await refetch();
      onResolved();
    } catch (e) {
      toastError("選べませんでした", errorMessage(e, ""));
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      size={{ base: "full", md: "lg" }}
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                <HStack gap={2}>
                  <LuScale />
                  <Text>分類の判断待ち</Text>
                  {conflicts.length > 0 && (
                    <Badge colorPalette="orange">{conflicts.length}件</Badge>
                  )}
                </HStack>
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="xs" color="fg.muted" mb={3}>
                分類ルールが2つ以上当てはまり、行き先が決まらなかったファイルです。
                選ぶまでは動かしていません。
              </Text>

              {loading && conflicts.length === 0 && <Spinner size="sm" />}
              {!loading && conflicts.length === 0 && (
                <Text fontSize="sm" color="fg.muted">
                  判断待ちはありません。
                </Text>
              )}

              <VStack align="stretch" gap={3}>
                {conflicts.map((c) => (
                  <Box
                    key={c.manualId}
                    borderWidth="1px"
                    borderColor="orange.emphasized"
                    borderRadius="md"
                    p={3}
                  >
                    <Text fontSize="sm" fontWeight="bold">
                      {c.title}
                    </Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      いまは「{c.currentCategory ?? "未分類"}」にあります
                    </Text>
                    <HStack gap={2} flexWrap="wrap">
                      {c.candidates.map((name) => (
                        <Button
                          key={name}
                          size="xs"
                          colorPalette="blue"
                          loading={saving}
                          onClick={() => void choose(c.manualId, name)}
                        >
                          「{name}」に入れる
                        </Button>
                      ))}
                      <Button
                        size="xs"
                        variant="outline"
                        loading={saving}
                        onClick={() => void choose(c.manualId, null)}
                      >
                        今のままにする
                      </Button>
                    </HStack>
                  </Box>
                ))}
              </VStack>
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
  );
}
