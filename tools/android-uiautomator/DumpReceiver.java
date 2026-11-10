package cn.viewphone.axprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Allows ViewPhone's local ADB connection to request the active hierarchy. */
public class DumpReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if ("cn.viewphone.axprobe.DUMP".equals(intent.getAction())) {
            AXProbe.dumpNow(intent.getStringExtra("token"));
        } else if ("cn.viewphone.axprobe.SET_TEXT".equals(intent.getAction())) {
            AXProbe.setFocusedText(
                context,
                intent.getStringExtra("token"),
                intent.getStringExtra("text")
            );
        }
    }
}
