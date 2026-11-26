package com.chatlingua.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;

/** Builds and cancels the incoming-call notification; shared by the activity and the FCM service. */
final class CallNotifications {
    static final String CHANNEL = "incoming_calls";
    static final int ID = 4101;
    private static final long LIFETIME = 46_000;

    private CallNotifications() {}

    static void cancel(Context context) {
        context.getSystemService(NotificationManager.class).cancel(ID);
    }

    static void cancelRoom(Context context, String room) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (room.equals(activeRoom(manager))) manager.cancel(ID);
    }

    private static String activeRoom(NotificationManager manager) {
        for (StatusBarNotification item : manager.getActiveNotifications()) {
            if (item.getId() == ID) return item.getNotification().extras.getString("room");
        }
        return null;
    }

    private static PendingIntent activityIntent(Context context, String action, String room, int code) {
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("action", action).putExtra("room", room);
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent declineIntent(Context context, String room) {
        Intent intent = new Intent(context, CallActionReceiver.class).setAction("com.chatlingua.app.DECLINE").putExtra("room", room);
        return PendingIntent.getBroadcast(context, 13, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Posts the notification. Returns true when the notification channel will play the ringtone itself. */
    static boolean ring(Context context, String name, String room, long lifetime) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return false;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        if (channel == null) {
            channel = new NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[] { 0, 600, 400, 600, 400, 600 });
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(channel);
        }
        if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        boolean audible = channel.getImportance() >= NotificationManager.IMPORTANCE_DEFAULT && channel.getSound() != null;
        // The push and the open page can both report the same call; ring once.
        if (room.equals(activeRoom(manager))) return audible;
        Bundle extras = new Bundle();
        extras.putString("room", room);
        Notification.Builder builder = new Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("Incoming call from " + name)
            .setContentText("ChatLingua video call")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(Math.max(1_000, Math.min(LIFETIME, lifetime)))
            .addExtras(extras)
            .setContentIntent(activityIntent(context, "show", room, 10))
            .addAction(new Notification.Action.Builder(Icon.createWithResource(context, android.R.drawable.sym_action_call),
                "Answer", activityIntent(context, "answer", room, 12)).build())
            .addAction(new Notification.Action.Builder(Icon.createWithResource(context, android.R.drawable.ic_menu_close_clear_cancel),
                "Decline", declineIntent(context, room)).build());
        // Without the Android 14 full-screen permission the high-priority notification still shows as a heads-up.
        builder.setFullScreenIntent(activityIntent(context, "show", room, 11), true);
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        manager.notify(ID, notification);
        return audible;
    }
}
