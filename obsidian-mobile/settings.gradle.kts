// OBSIDIAN — Obsidian Mobile
// Internal project name: Obsidian Mobile. User-facing application name: OBSIDIAN.
// The blockchain itself lives in ../obsidian-core and is NOT modified by this
// project: this is a client, plus a verify-and-relay-only Edge Node.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ObsidianMobile"
include(":app")
