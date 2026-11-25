package com.chatlingua.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class MainActivity extends Activity {
    private static final String ORIGIN = BuildConfig.CHATLINGUA_ORIGIN;
    private static final String CAMERA = Manifest.permission.CAMERA;
    private static final String MIC = Manifest.permission.RECORD_AUDIO;
    private final ThreadPoolExecutor audioQueue = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(24), new ThreadPoolExecutor.DiscardPolicy());
    private WebView web;
    private PermissionRequest pendingPermission;
    private SpeechRecognizer recognizer;
    private volatile OutputStream audio;
    private ParcelFileDescriptor recognitionSource;
    private long speechId;
    private Translator translator;
    private long translatorId;
    private AudioManager audioManager;
    private boolean changedAudioMode;
    private boolean routedAudio;
    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { notifyAudioDevices(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { notifyAudioDevices(); }
    };

    private void notifyAudioDevices() {
        if (!isDestroyed()) web.evaluateJavascript("window.androidAudioDevicesChanged?.()", null);
    }

    private static String outputName(AudioDeviceInfo device) {
        return switch (device.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth headset";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headset";
            case AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset";
            default -> null;
        };
    }

    private void clearAudioOutput() {
        routedAudio = false;
        audioManager.clearCommunicationDevice();
        if (changedAudioMode) {
            audioManager.setMode(AudioManager.MODE_NORMAL);
            changedAudioMode = false;
        }
    }

    private boolean trusted(Uri url) {
        return url != null && "https".equals(url.getScheme())
            && Uri.parse(ORIGIN).getHost().equals(url.getHost())
            && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "ChatLinguaAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.isForMainFrame() || !trusted(request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                if (!trusted(request.getOrigin()) || pendingPermission != null) {
                    request.deny();
                    return;
                }
                List<String> missing = new ArrayList<>();
                for (String resource : request.getResources()) {
                    String permission = switch (resource) {
                        case PermissionRequest.RESOURCE_VIDEO_CAPTURE -> CAMERA;
                        case PermissionRequest.RESOURCE_AUDIO_CAPTURE -> MIC;
                        default -> null;
                    };
                    if (permission == null) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
                }
                if (missing.isEmpty()) request.grant(request.getResources());
                else {
                    pendingPermission = request;
                    requestPermissions(missing.toArray(new String[0]), 1);
                }
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermission == request) pendingPermission = null;
            }
        });
        audioManager = getSystemService(AudioManager.class);
        audioManager.registerAudioDeviceCallback(deviceCallback, null);
        setContentView(web);
        Uri link = getIntent().getData();
        web.loadUrl(trusted(link) ? link.toString() : ORIGIN + "/");
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != 1 || pendingPermission == null) return;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (results.length == permissions.length && results.length > 0
            && checkSelfPermission(CAMERA) == PackageManager.PERMISSION_GRANTED
            && checkSelfPermission(MIC) == PackageManager.PERMISSION_GRANTED) request.grant(request.getResources());
        else request.deny();
    }

    private void reply(String callback, long id, String value) {
        if (!isDestroyed()) web.evaluateJavascript(
            "window." + callback + "?.(" + id + "," + JSONObject.quote(value) + ")", null);
    }

    private void stopSpeech() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        OutputStream previous = audio;
        audio = null;
        audioQueue.getQueue().clear();
        if (recognitionSource != null) {
            try { recognitionSource.close(); } catch (IOException ignored) {}
            recognitionSource = null;
        }
        if (previous != null) try { previous.close(); } catch (IOException ignored) {}
    }

    private void startSpeech(long id, String locale, int rate) {
        stopSpeech();
        speechId = id;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            reply("androidSpeechError", id, "service unavailable");
            return;
        }
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            recognitionSource = pipe[0];
            audio = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle parameters) {
                    if (speechId == id) reply("androidSpeechReady", id, "");
                }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rms) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(Bundle results) {}
                @Override public void onEvent(int type, Bundle parameters) {}
                private void sendResult(Bundle results) {
                    if (speechId != id) return;
                    ArrayList<String> words = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (words != null && !words.isEmpty()) reply("androidSpeechResult", id, words.get(0));
                }
                @Override public void onSegmentResults(Bundle results) {
                    sendResult(results);
                }
                @Override public void onEndOfSegmentedSession() {
                    end();
                }
                @Override public void onResults(Bundle results) {
                    sendResult(results);
                    end();
                }
                @Override public void onError(int code) {
                    if (speechId != id) return;
                    if (code != SpeechRecognizer.ERROR_NO_MATCH && code != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        reply("androidSpeechError", id, Integer.toString(code));
                    }
                    end();
                }
                private void end() {
                    if (speechId != id) return;
                    speechId = 0;
                    stopSpeech();
                    reply("androidSpeechEnd", id, "");
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
                .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, rate);
            recognizer.startListening(intent);
        } catch (IOException | RuntimeException error) {
            stopSpeech();
            reply("androidSpeechError", id, "audio setup failed");
        }
    }

    private final class Bridge {
        @JavascriptInterface public void start(long id, String locale, int rate) {
            if (locale.matches("[a-z]{2}-[A-Z]{2}") && rate >= 8000 && rate <= 48000) {
                runOnUiThread(() -> startSpeech(id, locale, rate));
            }
        }
        @JavascriptInterface public void stop(long id) {
            runOnUiThread(() -> {
                if (speechId == id) {
                    speechId = 0;
                    stopSpeech();
                }
            });
        }
        @JavascriptInterface public void feed(String base64) {
            OutputStream stream = audio;
            if (stream == null || base64.length() > 6000 || audioQueue.isShutdown()) return;
            audioQueue.execute(() -> {
                try { stream.write(Base64.decode(base64, Base64.DEFAULT)); }
                catch (IOException | IllegalArgumentException ignored) {}
            });
        }
        @JavascriptInterface public void prepare(long id, String source, String target) {
            if (!source.matches("[a-z]{2}") || !target.matches("[a-z]{2}")) return;
            runOnUiThread(() -> {
                if (translator != null) translator.close();
                translatorId = id;
                translator = Translation.getClient(new TranslatorOptions.Builder()
                    .setSourceLanguage(source).setTargetLanguage(target).build());
                translator.downloadModelIfNeeded()
                    .addOnSuccessListener(unused -> reply("androidTranslationResult", id, ""))
                    .addOnFailureListener(error -> reply("androidTranslationError", id, "Translation model could not be downloaded."));
            });
        }
        @JavascriptInterface public void translate(long id, long owner, String text) {
            if (text.length() > 600) return;
            runOnUiThread(() -> {
                if (translator == null || translatorId != owner) {
                    reply("androidTranslationError", id, "Translation session ended.");
                    return;
                }
                translator.translate(text)
                    .addOnSuccessListener(value -> reply("androidTranslationResult", id, value))
                    .addOnFailureListener(error -> reply("androidTranslationError", id, "Caption translation failed."));
            });
        }
        @JavascriptInterface public void release(long id) {
            runOnUiThread(() -> {
                if (translatorId == id && translator != null) {
                    translator.close();
                    translator = null;
                }
            });
        }
        @JavascriptInterface public String audioOutputs() {
            JSONArray list = new JSONArray();
            try {
                for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                    String name = outputName(device);
                    if (name == null) continue;
                    CharSequence product = device.getProductName();
                    boolean named = name.equals("Bluetooth headset") || name.equals("USB headset");
                    list.put(new JSONObject().put("id", Integer.toString(device.getId())).put("name", name)
                        .put("product", named && product != null ? product.toString() : ""));
                }
            } catch (JSONException | RuntimeException ignored) {}
            return list.toString();
        }
        @JavascriptInterface public void setAudioOutput(String id) {
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                if (id.isEmpty()) {
                    clearAudioOutput();
                    return;
                }
                for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
                    if (Integer.toString(device.getId()).equals(id)) {
                        if (audioManager.getMode() == AudioManager.MODE_NORMAL) {
                            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                            changedAudioMode = true;
                        }
                        routedAudio = audioManager.setCommunicationDevice(device);
                        return;
                    }
                }
            });
        }
        @JavascriptInterface public void callEnded() {
            runOnUiThread(() -> { if (!isDestroyed() && (routedAudio || changedAudioMode)) clearAudioOutput(); });
        }
        @JavascriptInterface public void share(String url) {
            if (!trusted(Uri.parse(url))) return;
            runOnUiThread(() -> startActivity(Intent.createChooser(
                new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), "Invite to ChatLingua")));
        }
        @JavascriptInterface public void shareImage(String base64Png, String url) {
            if (!trusted(Uri.parse(url)) || base64Png == null || base64Png.length() > 2_000_000) return;
            try {
                File dir = new File(getCacheDir(), "shared");
                if (!dir.isDirectory() && !dir.mkdirs()) return;
                File file = new File(dir, "chatlingua-invite.png");
                try (FileOutputStream out = new FileOutputStream(file)) { out.write(Base64.decode(base64Png, Base64.DEFAULT)); }
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", file);
                runOnUiThread(() -> startActivity(Intent.createChooser(
                    new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TEXT, url)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Invite to ChatLingua")));
            } catch (IOException | IllegalArgumentException ignored) {}
        }
    }

    @Override protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }

    @Override protected void onDestroy() {
        speechId = 0;
        stopSpeech();
        audioManager.unregisterAudioDeviceCallback(deviceCallback);
        if (routedAudio || changedAudioMode) clearAudioOutput();
        audioQueue.shutdownNow();
        if (translator != null) translator.close();
        CookieManager.getInstance().flush();
        web.destroy();
        super.onDestroy();
    }
}

