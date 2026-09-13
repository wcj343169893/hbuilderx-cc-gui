package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.ui.jcef.JBCefBrowser;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Integration tests for the {@code onStreamEnded()} host hook on the REAL
 * {@link StreamMessageCoalescer} — the signal ClaudeChatWindow uses to drain a
 * deferred background-turn reload at the safe point (stream inactive).
 *
 * <p>These drive the production coalescer (not a re-implementation), so they
 * catch regressions in the actual onStreamStart/onStreamEnd lifecycle: the hook
 * firing, the {@code streamActive} transition, and per-turn repetition.
 */
public class StreamMessageCoalescerStreamEndHookTest {

    /** Minimal JsCallbackTarget that counts onStreamEnded() firings. */
    private static final class CountingTarget implements StreamMessageCoalescer.JsCallbackTarget {
        final AtomicInteger streamEndedCount = new AtomicInteger();

        @Override public void callJavaScript(String functionName, String... args) {}
        @Override public JBCefBrowser getBrowser() { return null; }
        @Override public boolean isDisposed() { return false; }
        @Override public HandlerContext getHandlerContext() { return null; }
        @Override public void onStreamEnded() { streamEndedCount.incrementAndGet(); }
    }

    @Test
    public void onStreamEndFiresHookAndClearsActive() {
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            assertTrue("stream active after start", coalescer.isStreamActive());
            assertEquals("hook not fired yet", 0, target.streamEndedCount.get());

            coalescer.onStreamEnd();
            assertFalse("stream inactive after end", coalescer.isStreamActive());
            assertEquals("onStreamEnd fires the host hook exactly once", 1, target.streamEndedCount.get());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void hookFiresOncePerTurnAcrossMultipleTurns() {
        // A long session fans out many turns; the deferred-reload drain must get
        // a signal at EACH turn boundary, not just the first.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            for (int i = 0; i < 5; i++) {
                coalescer.onStreamStart();
                coalescer.onStreamEnd();
            }
            assertEquals("hook fires once per turn", 5, target.streamEndedCount.get());
            assertFalse(coalescer.isStreamActive());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void resetStreamStateClearsActiveWithoutFiringHook() {
        // resetStreamState() (new-session / restart) also drops streamActive, but
        // it is NOT a turn boundary — it must not fire the drain hook, or a reload
        // could run against a session the user just navigated away from.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            assertTrue(coalescer.isStreamActive());

            coalescer.resetStreamState();
            assertFalse("reset clears active", coalescer.isStreamActive());
            assertEquals("reset must NOT fire the drain hook", 0, target.streamEndedCount.get());
        } finally {
            coalescer.dispose();
        }
    }
}
