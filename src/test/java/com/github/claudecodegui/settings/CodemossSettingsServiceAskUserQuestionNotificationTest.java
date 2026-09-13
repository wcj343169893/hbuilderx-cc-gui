package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodemossSettingsServiceAskUserQuestionNotificationTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void defaultsToDisabledWhenMissingOrNull() throws Exception {
        Path tempHome = Files.createTempDirectory("ask-user-question-notification-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertFalse(service.getAskUserQuestionNotificationEnabled());

        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");
        Files.writeString(configPath, "{\"askUserQuestionNotificationEnabled\":null}", StandardCharsets.UTF_8);

        assertFalse(service.getAskUserQuestionNotificationEnabled());
    }

    @Test
    public void persistsEnabledFlagRoundTrip() throws Exception {
        Path tempHome = Files.createTempDirectory("ask-user-question-notification-persist-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        service.setAskUserQuestionNotificationEnabled(true);
        assertTrue(service.getAskUserQuestionNotificationEnabled());

        JsonObject config = service.readConfig();
        assertTrue(config.get("askUserQuestionNotificationEnabled").getAsBoolean());

        service.setAskUserQuestionNotificationEnabled(false);
        assertFalse(service.getAskUserQuestionNotificationEnabled());
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
