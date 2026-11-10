import { useCallback, useEffect, useState } from 'react';
import * as S from './store/core';
import { toast } from './ui';

/** Loads team details (git, members, spec types) for the active team. */
export function useTeamInfo() {
  const [info, setInfo] = useState<any>(null);
  const tid = S.state.teamId;
  const load = useCallback(async () => {
    try {
      const [t, m, ty] = await Promise.all([S.teamApi('GET', ''), S.teamApi('GET', '/members'), S.teamApi('GET', '/spec-types')]);
      if (tid === S.state.teamId) setInfo({ git: t.team.git, members: m.members, invites: m.invites, mailEnabled: t.team.mailEnabled, types: ty.types });
    } catch (e: any) { setInfo({ git: null, members: [], invites: [], types: [] }); toast(e.message); }
  }, [tid]);
  useEffect(() => { setInfo(null); load(); }, [load]);
  return { info, reload: load, setInfo };
}

export const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => { try { await fn(...a); } catch (e: any) { toast(e.message); } };
