import {
  useApolloClient,
  useLazyQuery,
  useMutation,
  useQuery,
} from "@apollo/client/react";
import { Box, Button, HStack, Spinner, Text } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { FcFolder, FcOpenedFolder } from "react-icons/fc";
import {
  LuArrowLeft,
  LuBot,
  LuDownload,
  LuFolderTree,
  LuScale,
  LuTrash2,
  LuUndo2,
} from "react-icons/lu";
import {
  CATEGORIES_QUERY,
  DELETE_CATEGORY_MUTATION,
} from "../../graphql/categories";
import {
  AUTO_ORGANIZE_MUTATION,
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  CLASSIFY_CONFLICTS_QUERY,
  LAST_RECLASSIFY_QUERY,
  MANUALS_QUERY,
  DELETE_MANUALS_MUTATION,
  MOVE_MANUAL_MUTATION,
  RECLASSIFY_SELECTED_MUTATION,
  RENAME_MANUAL_MUTATION,
  SET_MANUAL_PINNED_MUTATION,
  UNDO_RECLASSIFY_MUTATION,
  type Manual,
} from "../../graphql/manuals";
import { ME_QUERY } from "../../graphql/me";
import { ManualItemList, ViewModeSwitch } from "./ManualItemList";
import { ClassifyConflictDialog } from "./ClassifyConflictDialog";
import { useViewMode, type SortKey } from "../../lib/manualListView";
import { extensionOf } from "../../lib/fileTypes";
import { formatSize } from "../../lib/format";
import { updatedDateOf } from "../../lib/manualDate";
import { useBulkDownload } from "./useBulkDownload";
import { useManualViewer } from "./manualViewerContext";
import { Tooltip } from "../ui/Tooltip";
import {
  errorMessage,
  toastError,
  toastReport,
  toastSuccess,
} from "../../lib/toast";

/** 表示中の場所。null=ルート(全フォルダ+未分類のマニュアル) */
export type ExplorerFolder =
  { id: string; name: string } | "uncategorized" | null;

interface ManualExplorerProps {
  folder: ExplorerFolder;
  onNavigate: (folder: ExplorerFolder) => void;
}

/**
 * Windowsのエクスプローラー風のマニュアル一覧。
 * 一覧の見た目と操作はManualItemList(検索結果と共通)に任せ、
 * ここはフォルダの移動・取得と、フォルダ特有の操作(自動分類など)を担当する
 */
export function ManualExplorer({ folder, onNavigate }: ManualExplorerProps) {
  const isRoot = folder === null;
  const isUncategorized = folder === "uncategorized";

  const { data: meData } = useQuery(ME_QUERY);
  const isAdmin = meData?.me.role === "ADMIN";
  const { openManual } = useManualViewer();

  // フォルダ一覧も開くたびに取り直す。チャット経由の再分類などで
  // 裏でフォルダが増えていても、古いキャッシュのまま表示しないため
  const { data: categoriesData } = useQuery(CATEGORIES_QUERY, {
    fetchPolicy: "cache-and-network",
  });
  // ルートと未分類ビューは「カテゴリ未設定」のマニュアルを表示する
  const { data, loading, startPolling, stopPolling } = useQuery(MANUALS_QUERY, {
    variables:
      isRoot || isUncategorized
        ? { uncategorized: true }
        : { categoryId: folder.id },
    fetchPolicy: "cache-and-network", // 別画面での変更(アップロード等)を開くたびに反映
  });

  // 取り込み中のものがある間だけ、3秒ごとに一覧を取り直して進行状況を反映する
  const client = useApolloClient();
  const inFlight = (data?.manuals ?? []).filter(
    (m) => m.ingestStatus === "PENDING" || m.ingestStatus === "PROCESSING",
  );
  const hasInFlight = inFlight.length > 0;

  // 取り込みが終わった瞬間に結果を知らせる(押しただけでは終わりが分からないため)
  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const manuals = data?.manuals ?? [];
    const nowInFlight = new Set(
      manuals
        .filter(
          (m) =>
            m.ingestStatus === "PENDING" || m.ingestStatus === "PROCESSING",
        )
        .map((m) => m.id),
    );
    for (const id of watchedRef.current) {
      if (nowInFlight.has(id)) continue;
      const finished = manuals.find((m) => m.id === id);
      if (!finished) continue; // 一覧から消えた(削除・移動)ときは何も言わない
      if (finished.ingestStatus === "COMPLETED") {
        // 鍵付きフォルダの中身はAIの回答の根拠に使わない。
        // ここで「AI検索で使えます」と出すと事実と逆の説明になる
        // categoriesは下で並べ替えたもの。ここでは取得直後の一覧を見る
        const locked = (categoriesData?.manualCategories ?? []).some(
          (c) => c.id === finished.categoryId && c.adminOnly,
        );
        toastSuccess(
          `「${finished.title}」の取り込みが完了しました`,
          locked
            ? `${finished.chunkCount ?? 0}件のチャンク。鍵付きフォルダの中なので、AIの回答には使われません`
            : `${finished.chunkCount ?? 0}件のチャンク。AI検索で使えます`,
        );
      } else {
        toastError(
          `「${finished.title}」の取り込みに失敗しました`,
          finished.ingestError ?? undefined,
        );
      }
    }
    watchedRef.current = nowInFlight;
    // フォルダ一覧も見る(鍵付きかどうかで文言を変えるため)。
    // 再実行されてもwatchedRefで弾かれるので、通知が重複することはない
  }, [data, categoriesData?.manualCategories]);
  useEffect(() => {
    if (hasInFlight) {
      startPolling(3000);
      return () => {
        stopPolling();
        // 取り込み完了と同時に「AIにおまかせ」が新カテゴリを作っていることがある
        void client.refetchQueries({ include: ["ManualCategories"] });
      };
    }
    stopPolling();
  }, [hasInFlight, startPolling, stopPolling, client]);

  const [viewMode, changeViewMode] = useViewMode();

  // 並べ替え(詳細表示のヘッダーをクリック。アイコン表示にも同じ順序を適用)。
  // 未指定(null)のときは、フォルダはサイドバーで並び替えた順、マニュアルは名前順
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };
  const dir = sortAsc ? 1 : -1;
  const manuals = [...(data?.manuals ?? [])].sort((a, b) => {
    if (sortKey === "size") return (a.size - b.size) * dir;
    if (sortKey === "type")
      // 同じ種類の中では名前順にして、まとまりが読みやすいようにする
      return (
        extensionOf(a.fileName).localeCompare(extensionOf(b.fileName)) * dir ||
        a.title.localeCompare(b.title, "ja")
      );
    if (sortKey === "updatedAt")
      return (
        (updatedDateOf(a).date ?? "").localeCompare(
          updatedDateOf(b).date ?? "",
        ) * dir
      );
    return a.title.localeCompare(b.title, "ja") * (sortKey ? dir : 1);
  });
  // フォルダは常にファイルより先(Windowsと同じ)。
  // 列で並べ替えていないときは、サーバーから来た順(管理者が決めた並び)のまま
  const categories = sortKey
    ? [...(categoriesData?.manualCategories ?? [])].sort((a, b) => {
        if (sortKey === "updatedAt")
          return (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "") * dir;
        if (sortKey === "size")
          return ((a.totalSize ?? 0) - (b.totalSize ?? 0)) * dir;
        // フォルダに種類の違いは無いので、名前順のまま
        if (sortKey === "type") return a.name.localeCompare(b.name, "ja") * dir;
        return a.name.localeCompare(b.name, "ja") * dir;
      })
    : (categoriesData?.manualCategories ?? []);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 一括ダウンロード用のチェック
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const toggleCheck = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [checkedFolderIds, setCheckedFolderIds] = useState<Set<string>>(
    new Set(),
  );

  // フォルダを移動したら選択は解除する。
  // 描画のあと(effect)で消すと、移動先の一覧を前のフォルダの選択が付いたまま
  // 一度描いてしまうので、描画中にその場で合わせる
  const folderKey = isUncategorized ? "uncategorized" : (folder?.id ?? "root");
  const [lastFolderKey, setLastFolderKey] = useState(folderKey);
  if (lastFolderKey !== folderKey) {
    setLastFolderKey(folderKey);
    setCheckedIds(new Set());
    setCheckedFolderIds(new Set());
  }
  const toggleFolderCheck = (id: string) =>
    setCheckedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCheckAll = () => {
    // 判定に使うのは「画面に出ているフォルダ」だけ。フォルダの中では
    // フォルダ行が出ないのに全フォルダと突き合わせていたため、
    // 全部チェック済みでも「まだ全部ではない」と判断され、
    // もう一度押しても外れずに付け直されていた
    const shownFolders = isRoot ? categories : [];
    const allOn =
      manuals.every((m) => checkedIds.has(m.id)) &&
      shownFolders.every((c) => checkedFolderIds.has(c.id));
    setCheckedIds(allOn ? new Set() : new Set(manuals.map((m) => m.id)));
    setCheckedFolderIds(
      allOn ? new Set() : new Set(shownFolders.map((c) => c.id)),
    );
  };
  const checkedCount = checkedIds.size + checkedFolderIds.size;

  // 直前の再分類。戻せるものがある間だけ「元に戻す」を出す。
  // AIの分類は一度に何十件も動かすので、違ったときに手で直すのは現実的でない
  const { data: lastReclassifyData, refetch: refetchLastReclassify } = useQuery(
    LAST_RECLASSIFY_QUERY,
    { skip: !isAdmin, fetchPolicy: "cache-and-network" },
  );
  const lastReclassify = lastReclassifyData?.lastReclassify ?? null;
  const [undoReclassify, { loading: undoing }] = useMutation(
    UNDO_RECLASSIFY_MUTATION,
  );

  const handleUndoReclassify = async () => {
    if (!lastReclassify) return;
    if (
      !window.confirm(
        `直前の再分類（${lastReclassify.movedCount}件）を元に戻します。\n` +
          "再分類のあとに手で移動したファイルは、そのままにします。\nよろしいですか？",
      )
    )
      return;
    try {
      const { data } = await undoReclassify();
      const r = data?.undoLastReclassify;
      if (!r) return;
      await Promise.all([
        client.refetchQueries({ include: ["Manuals", "ManualCategories"] }),
        refetchLastReclassify(),
      ]);
      toastReport(
        `${r.restoredCount}件を元の場所に戻しました`,
        [
          r.skippedCount > 0
            ? `手で移動した${r.skippedCount}件はそのままにしました: ${r.skipped.join("、")}`
            : "",
          r.createdCategories.length > 0
            ? `空になった可能性のあるフォルダ: ${r.createdCategories.join("、")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n") || "再分類の前の状態に戻っています。",
      );
    } catch (e) {
      toastError("元に戻せませんでした", errorMessage(e, ""));
    }
  };

  // 分類ルールが2つ以上当てはまって行き先が決まらなかったもの。
  // AIに勝手に決めさせず、運用の判断としてADMINに選んでもらう。
  // 選ぶまで動かしていないので、放置しても分類が壊れることはない
  const [conflictOpen, setConflictOpen] = useState(false);
  const { data: conflictData, refetch: refetchConflicts } = useQuery(
    CLASSIFY_CONFLICTS_QUERY,
    { skip: !isAdmin, fetchPolicy: "cache-and-network" },
  );
  const conflictCount = conflictData?.pendingClassifyConflicts.length ?? 0;

  // 下部の状態バーに出す数。Windowsのエクスプローラーと同じで、
  // 「この場所に何個あるか」と「いくつ選んでいるか」がひと目で分かるようにする
  const shownFolderList = isRoot ? categories : [];
  const totalCount = shownFolderList.length + manuals.length;
  const checkedBytes =
    manuals.reduce((sum, m) => (checkedIds.has(m.id) ? sum + m.size : sum), 0) +
    shownFolderList.reduce(
      (sum, c) => (checkedFolderIds.has(c.id) ? sum + (c.totalSize ?? 0) : sum),
      0,
    );
  const { download, progress } = useBulkDownload();

  /** 表示中の場所の名前(ZIPのファイル名に使う) */
  const locationName = isRoot
    ? "マニュアル"
    : isUncategorized
      ? "未分類"
      : folder.name;

  /** ルートでは「全フォルダのマニュアル」を対象にするため、全件を取り直す */
  const [fetchAllManuals] = useLazyQuery(MANUALS_QUERY, {
    fetchPolicy: "network-only",
  });
  /** マニュアルの所属フォルダ名(ZIP内の階層に使う。未分類はルート直下) */
  const folderNameOf = (categoryId: string | null) =>
    categories.find((c) => c.id === categoryId)?.name;

  const downloadAll = async () => {
    const { data: all } = await fetchAllManuals();
    const items = (all?.manuals ?? []).map((m) => ({
      id: m.id,
      folder: folderNameOf(m.categoryId),
    }));
    await download(items, "マニュアル(全件)");
  };

  /** チェックしたフォルダの中身 + 個別にチェックしたファイル */
  const downloadChecked = async () => {
    const items: { id: string; folder?: string }[] = [];
    if (checkedFolderIds.size > 0) {
      // フォルダの中身は一覧に出ていないので、全件から取り出す
      const { data: all } = await fetchAllManuals();
      for (const m of all?.manuals ?? []) {
        if (m.categoryId && checkedFolderIds.has(m.categoryId)) {
          items.push({ id: m.id, folder: folderNameOf(m.categoryId) });
        }
      }
    }
    for (const id of checkedIds) {
      // フォルダ選択と重なったファイルは二重に入れない
      if (!items.some((item) => item.id === id)) items.push({ id });
    }
    await download(items, `${locationName}(選択)`);
  };

  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    refetchQueries: ["Manuals"],
  });
  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    refetchQueries: ["Manuals"],
  });
  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ["Manuals"],
  });
  const [setManualPinned] = useMutation(SET_MANUAL_PINNED_MUTATION, {
    refetchQueries: ["Manuals"],
  });
  const [deleteManuals] = useMutation(DELETE_MANUALS_MUTATION, {
    refetchQueries: ["Manuals", "ManualCategories"],
  });
  const [deleteCategory] = useMutation(DELETE_CATEGORY_MUTATION, {
    refetchQueries: ["Manuals", "ManualCategories"],
  });
  const [renameManual] = useMutation(RENAME_MANUAL_MUTATION, {
    refetchQueries: ["Manuals"],
  });
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifySelected] = useMutation(RECLASSIFY_SELECTED_MUTATION, {
    // 分類先が変わるので、一覧とフォルダの件数を取り直す
    refetchQueries: ["Manuals", "ManualCategories"],
  });
  const [autoOrganize, { loading: organizing }] = useMutation(
    AUTO_ORGANIZE_MUTATION,
    { refetchQueries: ["Manuals", "ManualCategories"] },
  );

  const handleDrop = async (manualId: string, categoryId: string) => {
    const manual = manuals.find((m) => m.id === manualId);
    if (manual && manual.categoryId === categoryId) return; // 同じ場所へは何もしない
    try {
      await moveManual({ variables: { id: manualId, categoryId } });
    } catch (e) {
      toastError("移動できませんでした", errorMessage(e, ""));
    }
  };

  /** 再取り込みを開始する。完了は上のuseEffectが検知して知らせる */
  const handleIngest = async (manual: Manual) => {
    try {
      await ingestManual({ variables: { id: manual.id } });
    } catch (e) {
      toastError("再取り込みを開始できませんでした", errorMessage(e, ""));
    }
  };

  /**
   * チェックした分をまとめて削除する(管理者のみ)。
   * フォルダは中身が残っていると消せない(サーバー側で拒否される)ので、
   * ファイルを消してからフォルダを消し、結果をまとめて知らせる
   */
  const [deleting, setDeleting] = useState(false);
  const deleteChecked = async () => {
    const fileCount = checkedIds.size;
    const folderCount = checkedFolderIds.size;
    if (
      !window.confirm(
        `選択した${fileCount > 0 ? `ファイル${fileCount}件` : ""}` +
          `${fileCount > 0 && folderCount > 0 ? "と" : ""}` +
          `${folderCount > 0 ? `フォルダ${folderCount}件` : ""}を削除します。\n` +
          "ゴミ箱から元に戻せます。" +
          (folderCount > 0 ? "\n\n(フォルダは中のファイルごと移動します)" : ""),
      )
    )
      return;

    setDeleting(true);
    try {
      let deletedFiles = 0;
      if (fileCount > 0) {
        const { data: result } = await deleteManuals({
          variables: { ids: [...checkedIds] },
        });
        deletedFiles = result?.deleteManuals ?? 0;
      }

      // フォルダは1件ずつ(中身も一緒にゴミ箱へ入る)
      const keptFolders: string[] = [];
      let deletedFolders = 0;
      for (const id of checkedFolderIds) {
        const name = categories.find((c) => c.id === id)?.name ?? "";
        try {
          await deleteCategory({ variables: { id } });
          deletedFolders++;
        } catch {
          keptFolders.push(name);
        }
      }

      setCheckedIds(new Set());
      setCheckedFolderIds(new Set());
      const lines = [
        deletedFiles > 0
          ? `ファイル${deletedFiles}件をゴミ箱に移動しました。`
          : "",
        deletedFolders > 0
          ? `フォルダ${deletedFolders}件を中身ごとゴミ箱に移動しました。`
          : "",
        keptFolders.length > 0
          ? `次のフォルダは移動できませんでした: ${keptFolders.join("、")}`
          : "",
      ].filter(Boolean);
      toastReport(
        "削除しました",
        lines.join("\n") || "削除できるものがありませんでした",
      );
    } catch (e) {
      toastError("削除できませんでした", errorMessage(e, ""));
    } finally {
      setDeleting(false);
    }
  };

  const handleDelete = async (manual: Manual) => {
    if (!window.confirm(`「${manual.title}」を削除しますか？元に戻せません。`))
      return;
    try {
      await deleteManual({ variables: { id: manual.id } });
    } catch (e) {
      toastError("削除できませんでした", errorMessage(e, ""));
    }
  };

  /** チェックしたファイルだけをAIで分類し直す */
  const reclassifyChecked = async () => {
    const ids = [...checkedIds];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `選択した${ids.length}件を、AIが内容から分類し直します。\n` +
          "合うフォルダが無ければ新しく作ります。\n" +
          "ピン留めしたファイルと、鍵付きフォルダの中のファイルは動かしません。よろしいですか？",
      )
    )
      return;
    setReclassifying(true);
    try {
      const { data } = await reclassifySelected({ variables: { ids } });
      const r = data?.reclassifySelectedManuals;
      if (!r) return;
      setCheckedIds(new Set());
      toastReport(
        r.movedCount > 0
          ? `${r.movedCount}件を分類し直しました`
          : "移動はありませんでした",
        (r.movedCount > 0
          ? r.moved
              // 鍵付きフォルダへ入れた分は🔒で区別する(一般利用者から見えなくなる)
              .map(
                (m) =>
                  `・${m.title} → ${m.adminOnly ? "🔒" : "📁"} ${m.categoryName}`,
              )
              .join("\n")
          : "今の分類のままです。") +
          // 増えたフォルダは必ず伝える(サイドバーに見慣れない箱が増えるため)
          (r.createdCategories.length > 0
            ? `\n\n新しく作ったフォルダ: ${r.createdCategories.join("、")}`
            : "") +
          // 動かさなかった分は理由と一緒に伝える(黙っていると直ったように見える)
          (r.skippedPinned.length > 0
            ? `\n\nピン留めのため動かしませんでした: ${r.skippedPinned.join("、")}` +
              "\n(右クリックのメニューからピン留めを外せます)"
            : "") +
          (r.skippedNotReady.length > 0
            ? `\n\n取り込みが終わっていないため分類できませんでした: ${r.skippedNotReady.join("、")}`
            : "") +
          // 鍵付きの中身を動かさない理由を伝える。黙って何も起きないと
          // 「分類が効かなかった」ようにしか見えない
          (r.skippedLocked.length > 0
            ? `\n\n鍵付きフォルダの中にあるため動かしませんでした: ${r.skippedLocked.join("、")}` +
              "\n(AIの分類で鍵の外へ出ると全員に見えてしまうためです。" +
              "移したいときは一覧でドラッグするか、チャットで移動を指示してください)"
            : "") +
          // ルールが食い違った分。動かしていないので、選んでもらうまで
          // 元の場所のまま残っていることをはっきり伝える
          (r.conflictedCount > 0
            ? `\n\n⚖️ ${r.conflictedCount}件は分類ルールが2つ以上当てはまったため、動かしていません` +
              "\n(上の「分類の判断待ち」から行き先を選んでください)"
            : ""),
      );
      void refetchConflicts();
    } catch (e) {
      toastError("分類し直せませんでした", errorMessage(e, ""));
    } finally {
      setReclassifying(false);
    }
  };

  const handleAutoOrganize = async () => {
    if (
      !window.confirm(
        `未分類の${manuals.length}件をAIが内容から分類します（必要ならカテゴリも自動作成されます）。よろしいですか？`,
      )
    )
      return;
    try {
      const { data: result } = await autoOrganize();
      if (result) {
        const {
          movedCount,
          createdCategories,
          movedToLocked,
          conflictedCount,
        } = result.autoOrganizeManuals;
        const notes = [
          createdCategories.length > 0
            ? `新しく作られたフォルダ: ${createdCategories.join("、")}`
            : "",
          // 鍵付きへ入った分は必ず伝える(一般利用者からは見えなくなる)
          movedToLocked.length > 0
            ? `🔒 ${movedToLocked.join("、")} は鍵付きフォルダへ入れたので、` +
              "一般の利用者からは見えなくなりました"
            : "",
          conflictedCount > 0
            ? `⚖️ ${conflictedCount}件は分類ルールが2つ以上当てはまったため動かしていません` +
              "(「分類の判断待ち」から行き先を選んでください)"
            : "",
        ].filter(Boolean);
        toastSuccess(
          `${movedCount}件を分類しました`,
          notes.length > 0 ? notes.join("\n") : undefined,
        );
        void refetchConflicts();
      }
    } catch (e) {
      toastError("自動分類に失敗しました", errorMessage(e, ""));
    }
  };

  return (
    // ツールバーは固定、一覧だけをスクロールさせる。
    // ファイルが増えてもダウンロードや表示切替のボタンに手が届くようにする
    <Box
      h="100%"
      display="flex"
      flexDirection="column"
      pt={{ base: 14, md: 6 }}
    >
      {/* ツールバー: パンくず + 操作 + 表示切替 */}
      <HStack
        px={{ base: 4, md: 6 }}
        pb={4}
        gap={2}
        flexWrap="wrap"
        flexShrink={0}
      >
        {!isRoot && (
          <Tooltip label="ひとつ上へ">
            <Button
              size="xs"
              variant="outline"
              onClick={() => onNavigate(null)}
            >
              <LuArrowLeft />
            </Button>
          </Tooltip>
        )}
        <Button
          size="xs"
          variant={isRoot ? "subtle" : "ghost"}
          fontWeight="bold"
          onClick={() => onNavigate(null)}
        >
          <LuFolderTree /> マニュアル
        </Button>
        {!isRoot && (
          <HStack gap={1} fontSize="sm" color="fg.muted">
            <Text>{">"}</Text>
            {isUncategorized ? (
              // 未分類はグレーのフォルダ(サイドバーと同じ見た目)
              <FcOpenedFolder
                style={{ filter: "grayscale(1)", opacity: 0.85 }}
              />
            ) : (
              <FcFolder />
            )}
            <Text>{isUncategorized ? "未分類" : folder.name}</Text>
          </HStack>
        )}
        <Box flex="1" />
        {/* ルールが食い違って保留になったもの。件数が0なら出さない */}
        {isAdmin && conflictCount > 0 && (
          <Tooltip label="分類ルールが2つ以上当てはまり、行き先が決まらなかったファイルです">
            <Button
              size="xs"
              colorPalette="orange"
              variant="outline"
              onClick={() => setConflictOpen(true)}
            >
              <LuScale /> 分類の判断待ち({conflictCount}件)
            </Button>
          </Tooltip>
        )}
        {/* 直前の再分類を取り消す。AIの分類が思っていたのと違ったときに、
            手で1件ずつ直さなくて済むようにする */}
        {isAdmin && lastReclassify && (
          <Tooltip
            label={
              lastReclassify.createdCategories.length > 0
                ? `新しく作られたフォルダ: ${lastReclassify.createdCategories.join("、")}`
                : "再分類の前の分類に戻します"
            }
          >
            <Button
              size="xs"
              variant="outline"
              loading={undoing}
              onClick={() => void handleUndoReclassify()}
            >
              <LuUndo2 /> 直前の再分類({lastReclassify.movedCount}件)を元に戻す
            </Button>
          </Tooltip>
        )}
        {isAdmin && (isRoot || isUncategorized) && manuals.length > 0 && (
          <Button
            size="xs"
            colorPalette="purple"
            variant="outline"
            loading={organizing}
            onClick={() => void handleAutoOrganize()}
          >
            <LuBot /> 未分類をAIで自動分類
          </Button>
        )}
        {/* 一括ダウンロード。選択があれば選択分、無ければ表示中/全件 */}
        {checkedIds.size > 0 && isAdmin && (
          <Button
            size="xs"
            colorPalette="purple"
            variant="outline"
            loading={reclassifying}
            onClick={() => void reclassifyChecked()}
          >
            <LuBot /> 選択した{checkedIds.size}件を再分類
          </Button>
        )}
        {checkedCount > 0 && isAdmin && (
          <Button
            size="xs"
            colorPalette="red"
            variant="outline"
            loading={deleting}
            onClick={() => void deleteChecked()}
          >
            <LuTrash2 /> 選択した{checkedCount}件を削除
          </Button>
        )}
        {checkedCount > 0 ? (
          <Button
            size="xs"
            colorPalette="blue"
            variant="outline"
            loading={progress !== null}
            onClick={() => void downloadChecked()}
          >
            <LuDownload /> 選択した{checkedCount}件をダウンロード
          </Button>
        ) : isRoot ? (
          <Button
            size="xs"
            variant="outline"
            loading={progress !== null}
            onClick={() => void downloadAll()}
          >
            <LuDownload /> すべてダウンロード
          </Button>
        ) : (
          manuals.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              loading={progress !== null}
              onClick={() =>
                void download(
                  manuals.map((m) => ({ id: m.id })),
                  locationName,
                )
              }
            >
              <LuDownload /> このフォルダをダウンロード
            </Button>
          )
        )}
        <ViewModeSwitch viewMode={viewMode} onChange={changeViewMode} />
      </HStack>

      <Box
        flex="1"
        minH={0}
        overflowY="auto"
        // 名前の列を広げたときに横へ送れるようにする。
        // 縦と同じ箱でスクロールさせることで、列見出しの固定表示が効いたまま
        // 見出しと行が一緒に動く
        overflowX="auto"
        px={{ base: 4, md: 6 }}
        pb={{ base: 4, md: 6 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null);
        }}
      >
        {loading && !data && <Spinner />}

        {/* 取り込み中の件数を上部にも出す(アイコンの⏳だけだと気づきにくい) */}
        {hasInFlight && (
          <HStack
            mb={3}
            px={3}
            py={2}
            gap={2}
            borderWidth="1px"
            borderRadius="md"
            borderColor="orange.muted"
            bg="orange.subtle"
            fontSize="sm"
          >
            <Spinner size="xs" color="orange.fg" />
            <Text>
              {inFlight.length}件を取り込み中です（ページを離れても続きます。
              完了するとお知らせします）
            </Text>
          </HStack>
        )}

        <ManualItemList
          viewMode={viewMode}
          folders={isRoot ? categories : []} // フォルダが並ぶのはルートだけ
          manuals={manuals}
          isAdmin={isAdmin}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpenManual={(manual) => openManual(manual.id, manual.title)}
          onOpenFolder={(f) => onNavigate(f)}
          onDropToFolder={(manualId, categoryId) =>
            void handleDrop(manualId, categoryId)
          }
          onDeleteManual={(manual) => void handleDelete(manual)}
          onIngestManual={(manual) => void handleIngest(manual)}
          onRenameManual={(manual, title) => {
            void renameManual({ variables: { id: manual.id, title } }).catch(
              (e: unknown) =>
                toastError("名前を変更できませんでした", errorMessage(e, "")),
            );
          }}
          onTogglePin={(manual) =>
            void setManualPinned({
              variables: { id: manual.id, pinned: !manual.categoryPinned },
            })
          }
          checkedIds={checkedIds}
          onToggleCheck={toggleCheck}
          onToggleCheckAll={toggleCheckAll}
          checkedFolderIds={checkedFolderIds}
          onToggleFolderCheck={toggleFolderCheck}
          sortKey={sortKey ?? undefined}
          sortAsc={sortAsc}
          onSort={toggleSort}
        />

        {!loading && manuals.length === 0 && (isUncategorized || !isRoot) && (
          <Text mt={6} color="fg.muted" fontSize="sm">
            このフォルダは空です
          </Text>
        )}
        {isRoot &&
          !loading &&
          categories.length === 0 &&
          manuals.length === 0 && (
            <Text mt={6} color="fg.muted" fontSize="sm">
              まだフォルダもマニュアルもありません
            </Text>
          )}

        {isAdmin && (
          <Text mt={6} fontSize="xs" color="fg.subtle">
            ダブルクリックで開く / ドラッグでフォルダへ移動 /
            右クリックでメニュー(サイドバーのフォルダやゴミ箱にもドロップできます)
          </Text>
        )}
      </Box>

      {/* 状態バー(Windowsのエクスプローラーと同じ位置・同じ内容)。
          スクロール領域の外に置いて、下端に貼り付けたままにする */}
      {!loading && (
        <HStack
          px={{ base: 4, md: 6 }}
          py={1}
          gap={3}
          flexShrink={0}
          borderTopWidth="1px"
          color="fg.muted"
          fontSize="xs"
        >
          <Text>{totalCount} 個の項目</Text>
          {checkedCount > 0 && (
            <Text>
              {checkedCount} 個の項目を選択
              {checkedBytes > 0 && ` ${formatSize(checkedBytes)}`}
            </Text>
          )}
        </HStack>
      )}

      <ClassifyConflictDialog
        open={conflictOpen}
        onClose={() => setConflictOpen(false)}
        onResolved={() => {
          void client.refetchQueries({
            include: ["Manuals", "ManualCategories"],
          });
          void refetchConflicts();
        }}
      />
    </Box>
  );
}
