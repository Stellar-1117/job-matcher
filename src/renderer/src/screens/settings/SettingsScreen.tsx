import { useEffect, useState } from 'react';
import { Tabs } from '../../components/ui';
import ApiKeysTab from './ApiKeysTab';
import ModelsTab from './ModelsTab';
import RoutingTab from './RoutingTab';
import PromptsTab from './PromptsTab';
import GeneralTab from './GeneralTab';
import CompaniesTab from './CompaniesTab';

export type SettingsTab = 'keys' | 'models' | 'routing' | 'prompts' | 'companies' | 'general';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'keys', label: 'API keys' },
  { key: 'models', label: 'Model registry' },
  { key: 'routing', label: 'Task routing' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'companies', label: 'Companies' },
  { key: 'general', label: 'General' },
];

export default function SettingsScreen({ initialTab = 'keys' }: { initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-5">
        <h1 className="mb-3 text-xl font-semibold">Settings</h1>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === 'keys' && <ApiKeysTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'routing' && <RoutingTab />}
        {tab === 'prompts' && <PromptsTab />}
        {tab === 'companies' && <CompaniesTab />}
        {tab === 'general' && <GeneralTab />}
      </div>
    </div>
  );
}
