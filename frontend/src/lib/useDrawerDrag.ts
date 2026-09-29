import { useEffect, useRef, useState } from 'react'

/** 引き出しの幅(px)。画面の85%まで、最大320px */
export function drawerWidth(): number {
  return Math.min(320, window.innerWidth * 0.85)
}

/** 指を離したあと、開くか閉じるかを決める割合 */
const SNAP_RATIO = 0.4

/** 勢いよく払ったときは、距離が足りなくてもその向きへ送り出す(px/ms) */
const FLICK_VELOCITY = 0.4

/** 横の動きか縦の動きかを見分けるまでに必要な距離(px) */
const DIRECTION_LOCK = 8

/**
 * 触れた場所が「横にスクロールできる中身」の内側かを調べる。
 *
 * 画面のどこからでも引き出しを掴めるようにすると、横に長い表やコードの
 * スクロールを奪ってしまう。触れた要素から親をたどって確かめる
 */
function canScrollHorizontally(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * 指の動きに追従する引き出し。
 *
 * しきい値を超えたら開く、という作りだと「押したら出る」だけで、
 * どれくらい開いているかが指から分からない。ChatGPTのアプリのように
 * 指の位置に合わせてその場で動かし、離した時点の位置と勢いで
 * 開くか閉じるかを決める。
 *
 * 戻り値の progress は 0(閉)〜1(開)。描画側はこれを使って
 * 引き出しの位置と背景の濃さを決める。
 */
export function useDrawerDrag(
  enabled: boolean,
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  // 指で動かしている最中の開き具合(0〜1)。触っていないときはnull
  const [dragging, setDragging] = useState<number | null>(null)
  const state = useRef<{
    startX: number
    startY: number
    lastX: number
    lastTime: number
    velocity: number
    /** 横方向の操作だと確定したか */
    locked: boolean
    active: boolean
  } | null>(null)

  useEffect(() => {
    if (!enabled) return

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      // 画面のどこからでも掴める。左端だけに限ると、片手で持ったときに
      // 親指が届く範囲(画面の右寄り)から開けない
      //
      // ただし、その場所が横にスクロールできる中身(長い表やコード)なら
      // そちらを優先する。引き出しが出てしまうとスクロールできなくなる
      if (canScrollHorizontally(e.target)) return
      state.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastTime: e.timeStamp,
        velocity: 0,
        locked: false,
        active: true,
      }
    }

    const onMove = (e: TouchEvent) => {
      const s = state.current
      const touch = e.touches[0]
      if (!s?.active || !touch) return
      const dx = touch.clientX - s.startX
      const dy = touch.clientY - s.startY

      if (!s.locked) {
        // どちらの向きの操作かが決まるまでは何もしない。
        // 先に動かすと、縦スクロールのつもりの指で引き出しが出てしまう
        if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) {
          return
        }
        if (Math.abs(dx) <= Math.abs(dy)) {
          s.active = false // 縦の操作なので譲る
          return
        }
        s.locked = true
      }

      // 速さを覚えておく(離したときに勢いで判断するため)
      const dt = e.timeStamp - s.lastTime
      if (dt > 0) s.velocity = (touch.clientX - s.lastX) / dt
      s.lastX = touch.clientX
      s.lastTime = e.timeStamp

      const width = drawerWidth()
      const base = open ? width : 0
      const next = Math.max(0, Math.min(width, base + dx))
      // 横に動かすと決めた後は、画面が一緒に縦スクロールしないよう止める
      if (e.cancelable) e.preventDefault()
      setDragging(next / width)
    }

    const onEnd = () => {
      const s = state.current
      state.current = null
      if (!s?.locked) {
        setDragging(null)
        return
      }
      setDragging((current) => {
        const progress = current ?? (open ? 1 : 0)
        // 勢いよく払ったならその向きへ。そうでなければ位置で決める
        const decided =
          Math.abs(s.velocity) > FLICK_VELOCITY
            ? s.velocity > 0
            : progress > SNAP_RATIO
        setOpen(decided)
        return null
      })
    }

    // touchmoveだけは passive にしない(縦スクロールを止める必要があるため)
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, open, setOpen])

  return {
    /** 0(閉)〜1(開) */
    progress: dragging ?? (open ? 1 : 0),
    /** 指で動かしている最中か。アニメーションを切るために使う */
    isDragging: dragging !== null,
  }
}
