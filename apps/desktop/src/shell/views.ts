import { AgentsView } from "../views/AgentsView";
import { CollaborationView } from "../views/CollaborationView";
import { HomeView } from "../views/HomeView";
import { MarketplaceView } from "../views/MarketplaceView";
import { NewTaskView } from "../views/NewTaskView";
import { RoutinesView } from "../views/RoutinesView";
import { SettingsView } from "../views/SettingsView";
import { TaskView } from "../views/TaskView";
import { TemplatesView } from "../views/TemplatesView";
import type { ViewName } from "./router";

export const views = {
  home: HomeView,
  agents: AgentsView,
  new: NewTaskView,
  templates: TemplatesView,
  task: TaskView,
  collaboration: CollaborationView,
  routines: RoutinesView,
  marketplace: MarketplaceView,
  settings: SettingsView,
} satisfies Record<ViewName, () => React.JSX.Element>;
