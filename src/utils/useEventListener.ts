import { useEffect, useRef } from 'react';

const useEventListener = <TEvent extends string, Thandler>(
  emitter: { on(event: TEvent, callback: Thandler): () => void } | null,
  eventName: TEvent,
  handler: any,
  isCurrent?: () => boolean,
) => {
  const latest = useRef(handler);
  latest.current = handler;
  const enabled = Boolean(handler);
  useEffect(() => {
    if (!emitter || !enabled) return;
    const callback = (...args: unknown[]) => {
      if (isCurrent && !isCurrent()) return;
      latest.current?.(...args);
    };
    return emitter.on(eventName, callback as Thandler);
  }, [emitter, eventName, enabled, isCurrent]);
};

export default useEventListener;
