import { useEffect } from 'react';
import { pushEsc } from '../escStack.js';

/**
 * 统一弹窗遮罩：遮罩本身绝不因点击而关闭（仅显式按钮/Esc 关闭）。
 * closeOnEsc=true 且非 busy 且提供 onCancel 时，Esc 等价于取消。
 */
export default function ModalOverlay({ onCancel, closeOnEsc = false, busy = false, className, children, ...rest }) {
  const cls = className ? `modal-overlay ${className}` : 'modal-overlay';
  useEffect(() => {
    if (!closeOnEsc || busy || typeof onCancel !== 'function') return undefined;
    return pushEsc(() => onCancel());
  }, [closeOnEsc, busy, onCancel]);
  return <div className={cls} {...rest}>{children}</div>;
}
