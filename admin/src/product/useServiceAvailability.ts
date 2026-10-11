import { useEffect, useState } from 'react';
import { productFetch } from '../lib/product-fetch';

export function useServiceAvailability(phase?: string | null) {
  const [state, setState] = useState({ serviceReady: false, databaseReady: false });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await productFetch('/admin/api/workbench/availability');
        if (!response.ok) throw new Error(`服务状态读取失败 (${response.status})`);
        const next = await response.json();
        if (live) setState({ serviceReady: next.serviceReady === true, databaseReady: next.databaseReady === true });
      } catch { if (live) setState({ serviceReady: false, databaseReady: false }); }
      finally { if (live) timer = setTimeout(load, 1000); }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [phase]);
  return state;
}
