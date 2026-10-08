"use client";

import { useCallback, useEffect, useState } from "react";
import { addOwnMove, browserStorage, countUnseen, readOwnMoves, readSeenAt, writeSeenAt } from "./lib/nav";

export function useUnseenMoves(moves: ReadonlyArray<{ id?: string; movedAt: string }> | undefined, alertsActive: boolean) {
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [ownMoves, setOwnMoves] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSeenAt(readSeenAt(browserStorage(), Date.now()));
      setOwnMoves(readOwnMoves(browserStorage()));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const markSeen = useCallback(() => {
    const now = Date.now();
    writeSeenAt(browserStorage(), now);
    setSeenAt(now);
  }, []);

  const markOwnMove = useCallback((id: string, movedAt: string) => {
    setOwnMoves((current) => addOwnMove(browserStorage(), current, id, movedAt));
  }, []);

  useEffect(() => {
    if (!alertsActive || !moves) return;
    const timer = window.setTimeout(markSeen, 0);
    return () => window.clearTimeout(timer);
  }, [alertsActive, moves, markSeen]);

  return { unseen: seenAt === null || !moves ? 0 : countUnseen(moves, seenAt, ownMoves), markOwnMove };
}
