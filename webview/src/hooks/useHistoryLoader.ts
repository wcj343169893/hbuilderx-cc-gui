import { useEffect, useRef } from 'react';
import { sendBridgeEvent } from '../utils/bridge';
import type { HistoryData } from '../types';

// Upper bound on how long we wait for the backend to answer a
// load_history_data request before giving up. Without this, a host that
// never invokes setHistoryData (e.g. a stale plugin runtime whose
// message-router lacks the history case, a dropped bridge message, or a
// backend exception) leaves the History view spinning forever.
const HISTORY_LOAD_TIMEOUT_MS = 15000;

export interface UseHistoryLoaderOptions {
  currentView: 'chat' | 'history' | 'settings';
  currentProvider: string;
  /** Latest history payload; used to detect whether the backend answered. */
  historyData: HistoryData | null;
  /** Setter used to surface an error state if the backend never responds. */
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
}

export function useHistoryLoader(options: UseHistoryLoaderOptions): void {
  const { currentView, currentProvider, historyData, setHistoryData } = options;

  // Read the latest historyData from inside the timeout without making it an
  // effect dependency (which would resend the request on every data change).
  const historyDataRef = useRef(historyData);
  historyDataRef.current = historyData;

  useEffect(() => {
    if (currentView !== 'history') {
      return;
    }

    let historyRetryCount = 0;
    const MAX_HISTORY_RETRIES = 30;
    let currentTimer: ReturnType<typeof setTimeout> | null = null;
    let loadTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // Snapshot the payload present when the view opened. If it is still the
    // exact same reference once the timeout fires, the backend never answered
    // this request and we must clear the spinner with an error state.
    const dataAtRequestTime = historyDataRef.current;

    const requestHistoryData = () => {
      if (window.sendToJava) {
        sendBridgeEvent('load_history_data', currentProvider);
        loadTimeoutTimer = setTimeout(() => {
          loadTimeoutTimer = null;
          if (historyDataRef.current === dataAtRequestTime) {
            setHistoryData({
              success: false,
              sessions: [],
              total: 0,
              favorites: {},
            });
          }
        }, HISTORY_LOAD_TIMEOUT_MS);
      } else {
        historyRetryCount++;
        if (historyRetryCount < MAX_HISTORY_RETRIES) {
          currentTimer = setTimeout(requestHistoryData, 100);
        } else {
          console.warn('[Frontend] Failed to load history data: bridge not available after', MAX_HISTORY_RETRIES, 'retries');
          // Bridge never became available; clear the spinner with an error.
          if (historyDataRef.current === dataAtRequestTime) {
            setHistoryData({
              success: false,
              sessions: [],
              total: 0,
              favorites: {},
            });
          }
        }
      }
    };

    currentTimer = setTimeout(requestHistoryData, 50);

    return () => {
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      if (loadTimeoutTimer) {
        clearTimeout(loadTimeoutTimer);
      }
    };
  }, [currentView, currentProvider, setHistoryData]);
}
