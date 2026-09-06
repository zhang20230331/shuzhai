package com.shuzhai.reader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;

/** 听书前台服务：锁屏/下拉通知栏显示媒体卡片（标题、播放/暂停、上一句、下一句） */
public class PlaybackService extends Service {
    private static final String CHANNEL = "shuzhai_playback";
    public static MediaSessionCompat session;
    public static String title = "听书中";
    public static String artist = "书斋";
    public static boolean playing = false;

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSessionCompat(this, "ShuZhai");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { MainActivity.evalJs("(window.__szMedia&&window.__szMedia('play'))"); }
            @Override public void onPause() { MainActivity.evalJs("(window.__szMedia&&window.__szMedia('pause'))"); }
            @Override public void onSkipToNext() { MainActivity.evalJs("(window.__szMedia&&window.__szMedia('next'))"); }
            @Override public void onSkipToPrevious() { MainActivity.evalJs("(window.__szMedia&&window.__szMedia('prev'))"); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if ("PLAY".equals(action) || "PAUSE".equals(action)) {
            MainActivity.evalJs("(window.__szMedia&&window.__szMedia('" + ("PLAY".equals(action) ? "play" : "pause") + "'))");
        } else if ("PREV".equals(action)) {
            MainActivity.evalJs("(window.__szMedia&&window.__szMedia('prev'))");
        } else if ("NEXT".equals(action)) {
            MainActivity.evalJs("(window.__szMedia&&window.__szMedia('next'))");
        }
        String t = intent != null ? intent.getStringExtra("title") : null;
        String a = intent != null ? intent.getStringExtra("artist") : null;
        if (t != null) title = t;
        if (a != null) artist = a;
        if (intent != null) playing = intent.getBooleanExtra("playing", playing);
        update();
        return START_NOT_STICKY;
    }

    private void update() {
        if (session != null) {
            session.setMetadata(new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                    .build());
            session.setPlaybackState(new PlaybackStateCompat.Builder()
                    .setActions(PlaybackStateCompat.ACTION_PLAY
                            | PlaybackStateCompat.ACTION_PAUSE
                            | PlaybackStateCompat.ACTION_PLAY_PAUSE
                            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
                    .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, 0, 1f)
                    .build());
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "听书播放", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        startForeground(1, buildNotification());
    }

    private Notification buildNotification() {
        Intent prev = new Intent(this, PlaybackService.class).setAction("PREV");
        Intent toggle = new Intent(this, PlaybackService.class).setAction(playing ? "PAUSE" : "PLAY");
        Intent next = new Intent(this, PlaybackService.class).setAction("NEXT");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title)
                .setContentText(artist)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_previous, "上一句",
                        PendingIntent.getService(this, 2, prev, flags)))
                .addAction(new NotificationCompat.Action(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, "播放",
                        PendingIntent.getService(this, 3, toggle, flags)))
                .addAction(new NotificationCompat.Action(android.R.drawable.ic_media_next, "下一句",
                        PendingIntent.getService(this, 4, next, flags)))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
