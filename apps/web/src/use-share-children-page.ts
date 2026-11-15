import { useEffect, useRef, useState } from "react";
import { publicShareApi } from "./api.js";
import type { ShareChild } from "./types.js";

const emptyPage = { items: [] as readonly ShareChild[], parentId: undefined as string | undefined, offset: 0, previousOffsets: [] as readonly number[], nextOffset: null as number | null };
export function useShareChildrenPage(token: string) {
  const [page, setPage] = useState(emptyPage);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const currentToken = useRef(token);
  currentToken.current = token;
  useEffect(() => { setPage(emptyPage); setLoading(false); return () => { active.current?.abort(); }; }, [token]);
  const load = async (parentId?: string, offset = 0, previousOffsets: readonly number[] = []): Promise<boolean> => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setLoading(true);
    try {
      const value = await publicShareApi.childrenPage(token, parentId, offset, controller.signal);
      if (controller.signal.aborted || currentToken.current !== token) return false;
      setPage({ items: value.items, parentId, offset, previousOffsets, nextOffset: value.nextOffset });
      return true;
    } catch (error) { if (controller.signal.aborted) return false; throw error; }
    finally { if (active.current === controller) setLoading(false); }
  };
  return { ...page, loading, load,
    next: () => page.nextOffset === null ? Promise.resolve(false) : load(page.parentId, page.nextOffset, [...page.previousOffsets, page.offset]),
    previous: () => page.previousOffsets.length === 0 ? Promise.resolve(false) : load(page.parentId, page.previousOffsets.at(-1), page.previousOffsets.slice(0, -1)),
  };
}
