import { useEffect, useState } from 'react'

/**
 * タッチ操作の端末かどうかを返す。
 *
 * スマホ・タブレットでは、右クリック・ドラッグ・ダブルタップが使えないか
 * 扱いにくい。画面の広さではなく入力方法で判断する(小さいウィンドウの
 * PCでマウス操作を奪わないため)。
 */
export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false)

  useEffect(() => {
    // 「粗いポインタ(指)で、ホバーできない」= タッチ主体の端末
    const query = window.matchMedia('(hover: none) and (pointer: coarse)')
    const update = () => setIsTouch(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return isTouch
}
