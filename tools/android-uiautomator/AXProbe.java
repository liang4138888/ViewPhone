package cn.viewphone.axprobe;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.Log;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.util.ArrayDeque;
import java.util.Queue;

/**
 * Local hierarchy probe used when MIUI's uiautomator cannot reach an idle state.
 * It reads the active window only after a local ADB broadcast requests it.
 */
public class AXProbe extends AccessibilityService {
    private static final String TAG = "ViewPhoneAX";
    private static AXProbe instance;
    private boolean dumping;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        AccessibilityServiceInfo info = getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        setServiceInfo(info);
        Log.i(TAG, "accessibility service ready");
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // The hierarchy is requested explicitly by DumpReceiver so every dump
        // reflects the current page instead of a stale window-state event.
    }

    static void dumpNow(String token) {
        AXProbe service = instance;
        if (service == null || token == null || !token.matches("[a-zA-Z0-9-]{1,64}")) return;
        service.dumpActiveWindow(token);
    }

    /** Set Unicode text on the focused editable node without depending on an IME. */
    static void setFocusedText(Context context, String token, String encodedText) {
        AXProbe service = instance;
        if (token == null || !token.matches("[a-zA-Z0-9-]{1,64}")) return;
        if (service == null) {
            writeResult(context.getFilesDir(), token, "ERROR:accessibility-service-not-ready");
            return;
        }
        service.setFocusedTextNow(token, encodedText);
    }

    private synchronized void setFocusedTextNow(String token, String encodedText) {
        String text;
        try {
            text = new String(
                Base64.decode(encodedText, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING),
                "UTF-8"
            );
        } catch (Exception error) {
            writeResult(getFilesDir(), token, "ERROR:invalid-text-encoding");
            return;
        }
        AccessibilityNodeInfo focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) focused = findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
        if (focused == null) {
            Log.w(TAG, "set text failed: no focused input");
            writeResult(getFilesDir(), token, "ERROR:no-focused-input");
            return;
        }
        AccessibilityNodeInfo editable = findEditable(focused, 0);
        if (editable == null) {
            Log.w(TAG, "set text failed: focused node is not editable");
            writeResult(getFilesDir(), token, "ERROR:not-editable");
            return;
        }
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean succeeded = editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        if (!succeeded) {
            Log.w(TAG, "set text failed: ACTION_SET_TEXT rejected");
            writeResult(getFilesDir(), token, "ERROR:action-set-text-rejected");
        } else {
            writeResult(getFilesDir(), token, "OK");
        }
    }

    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 20) return null;
        if (node.isEditable()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo match = findEditable(node.getChild(i), depth + 1);
            if (match != null) return match;
        }
        return null;
    }

    private synchronized void dumpActiveWindow(String token) {
        if (dumping) return;
        dumping = true;
        File result = new File(getFilesDir(), "layout-" + token + ".xml");
        File complete = new File(getFilesDir(), "complete-" + token);
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) {
                write(complete, "ERROR:no-active-window");
                return;
            }
            StringBuilder xml = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<hierarchy>");
            Queue<AccessibilityNodeInfo> queue = new ArrayDeque<>();
            queue.add(root);
            int count = 0;
            while (!queue.isEmpty() && count++ < 8000) {
                AccessibilityNodeInfo node = queue.remove();
                appendNode(xml, node);
                for (int i = 0; i < node.getChildCount(); i++) {
                    AccessibilityNodeInfo child = node.getChild(i);
                    if (child != null) queue.add(child);
                }
            }
            xml.append("</hierarchy>");
            write(result, xml.toString());
            write(complete, "OK");
        } catch (Exception error) {
            Log.e(TAG, "dump failed", error);
            write(complete, "ERROR:" + error.getMessage());
        } finally {
            dumping = false;
        }
    }

    private static void appendNode(StringBuilder xml, AccessibilityNodeInfo node) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.append("<node text=\"").append(escape(node.getText()))
            .append("\" resource-id=\"").append(escape(node.getViewIdResourceName()))
            .append("\" content-desc=\"").append(escape(node.getContentDescription()))
            .append("\" class=\"").append(escape(node.getClassName()))
            .append("\" bounds=\"[").append(bounds.left).append(',')
            .append(bounds.top).append("][").append(bounds.right).append(',')
            .append(bounds.bottom).append("]\" clickable=\"")
            .append(node.isClickable()).append("\" enabled=\"")
            .append(node.isEnabled()).append("\" scrollable=\"")
            .append(node.isScrollable()).append("\" password=\"")
            .append(node.isPassword()).append("\"/>");
    }

    private static String escape(CharSequence value) {
        return String.valueOf(value == null ? "" : value)
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;");
    }

    private static void write(String path, String value) {
        File file = new File(path);
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        try (BufferedWriter writer = new BufferedWriter(new FileWriter(file))) {
            writer.write(value);
        } catch (Exception error) {
            Log.e(TAG, "write failed: " + path, error);
        }
    }

    private static void write(File file, String value) {
        write(file.getAbsolutePath(), value);
    }

    private static void writeResult(File directory, String token, String value) {
        write(new File(directory, "text-complete-" + token), value);
    }
}
