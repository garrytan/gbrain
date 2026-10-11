import { ActivationDialog } from "./ActivationDialog";
import { ConnectionDialogs } from "./ConnectionDialogs";
import { ModelEditorDialog } from "./ModelEditorDialog";
import { ModelSyncDialog } from "./ModelSyncDialog";
import { ProviderWizardDialog } from "./ProviderWizardDialog";
import type { ModelServicesController } from "./useModelServices";

export function ModelDialogs({ model }: { model: ModelServicesController }) {
  return (
    <>
      <ModelEditorDialog model={model} />
      <ConnectionDialogs model={model} />
      <ProviderWizardDialog model={model} />
      <ModelSyncDialog model={model} />
      <ActivationDialog model={model} />
    </>
  );
}
