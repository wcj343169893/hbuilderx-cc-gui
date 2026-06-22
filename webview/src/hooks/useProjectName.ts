import { useEffect, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

/**
 * HBuilderX 可同时打开多个项目，故会话需绑定到具体项目。
 * 宿主通过 `window.onProjectChanged({name,path})` 推送当前会话所属项目名，在顶部会话名后展示。
 * 点击项目名 -> 发 `select_project` 事件，宿主弹原生选择器切换项目（IDEA 版不推送此回调，故为空、不展示）。
 */
export function useProjectName(): { projectName: string; selectProject: () => void } {
  const [projectName, setProjectName] = useState('');

  useEffect(() => {
    const prev = window.onProjectChanged;
    window.onProjectChanged = (json: string) => {
      try {
        const o = JSON.parse(json);
        setProjectName((o && typeof o.name === 'string') ? o.name : '');
      } catch {
        /* ignore malformed payload */
      }
      if (typeof prev === 'function' && prev !== window.onProjectChanged) {
        try { prev(json); } catch { /* ignore chained handler error */ }
      }
    };
    // 宿主 bootstrap 的 onProjectChanged 推送可能早于本回调注册，被桥接 shim 静默丢弃，
    // 导致顶部一直拿不到项目名。故挂载（已注册回调）后主动拉取一次，宿主收到即回推。
    sendBridgeEvent('request_project');
    return () => { window.onProjectChanged = prev; };
  }, []);

  const selectProject = () => sendBridgeEvent('select_project');
  return { projectName, selectProject };
}
