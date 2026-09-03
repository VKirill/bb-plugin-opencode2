import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SettingsSection } from "./app/settings-section.tsx";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "models",
    title: "Provider and models",
    description: "Choose which OpenCode v2 models BB should offer.",
    component: SettingsSection,
  });
});
