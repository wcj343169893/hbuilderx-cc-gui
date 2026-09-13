package com.github.claudecodegui.skill;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SlashCommandPathPolicyTest {

    @Test
    public void matchesPathPatternsSupportsNestedPathMatchingAndRejectsDangerousGlobs() {
        Path currentFile = Path.of("/workspace/demo/src/main/App.java");

        assertTrue(SlashCommandPathPolicy.matchesPathPatterns(currentFile, List.of("src/**/*.java")));
        assertTrue(SlashCommandPathPolicy.matchesPathPatterns(currentFile, List.of("App.java")));
        assertFalse(SlashCommandPathPolicy.matchesPathPatterns(currentFile, List.of("**/**/**/**/**/App.java")));
        assertFalse(SlashCommandPathPolicy.matchesPathPatterns(currentFile, List.of("src/**/*.kt")));
    }

    @Test
    public void resolveManagedSkillsDirectorySupportsClaudeAndDirectSkillsLayouts() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-layouts");
        Path claudeManaged = Files.createDirectories(root.resolve("managed").resolve(".claude").resolve("skills"));
        Path directManaged = Files.createDirectories(root.resolve("direct").resolve("skills"));

        assertEquals(claudeManaged, SlashCommandPathPolicy.resolveManagedSkillsDirectory(root.resolve("managed")));
        assertEquals(directManaged, SlashCommandPathPolicy.resolveManagedSkillsDirectory(root.resolve("direct")));
        assertEquals(directManaged, SlashCommandPathPolicy.resolveManagedSkillsDirectory(directManaged));
    }

    @Test
    public void pluginPathSafetyRejectsEscapesAndMarketplaceTraversal() throws IOException {
        Path root = Files.createTempDirectory("slash-command-plugin-policy");
        Path pluginDir = Files.createDirectories(root.resolve("plugin"));
        Path validSubDir = Files.createDirectories(pluginDir.resolve("commands"));
        Path marketplace = Files.createDirectories(root.resolve("marketplace"));
        Path pluginEntry = Files.createDirectories(marketplace.resolve("plugins").resolve("demo"));
        Path manifest = Files.createDirectories(pluginEntry.resolve(".claude-plugin")).resolve("plugin.json");
        Files.writeString(manifest, "{}");

        Path resolved = SlashCommandPathPolicy.resolvePluginSubPath(pluginDir, "commands");

        assertNotNull(resolved);
        assertTrue(SlashCommandPathPolicy.isPluginPathSafe(validSubDir, pluginDir));
        assertNull(SlashCommandPathPolicy.resolvePluginSubPath(pluginDir, "/tmp/commands"));
        assertFalse(SlashCommandPathPolicy.isSafePluginId("../escape"));
        assertNull(SlashCommandPathPolicy.resolveMarketplaceManifestPath(
                "../escape",
                "market",
                Map.of("market", marketplace.toString())
        ));
    }

    @Test
    public void pluginPathSafetyFallbackStillRejectsTraversalWhenRealPathFails() throws IOException {
        // toRealPath() throws for nonexistent paths, forcing isPluginPathSafe onto its
        // normalized-containment fallback (the branch used for flaky \\wsl.localhost UNC paths).
        Path root = Files.createTempDirectory("slash-command-plugin-fallback");
        Path pluginDir = Files.createDirectories(root.resolve("plugin"));

        Path missingSubDir = pluginDir.resolve("skills");
        assertTrue("Contained-but-unresolvable subdir must pass the fallback check",
                SlashCommandPathPolicy.isPluginPathSafe(missingSubDir, pluginDir));

        Path traversal = pluginDir.resolve("..").resolve("escape");
        assertFalse("Traversal escape must be rejected by the fallback check",
                SlashCommandPathPolicy.isPluginPathSafe(traversal, pluginDir));

        Path missingPluginDir = root.resolve("missing-plugin");
        assertFalse("Plugin dir itself must be rejected even on the fallback path",
                SlashCommandPathPolicy.isPluginPathSafe(missingPluginDir, missingPluginDir));
    }
}
