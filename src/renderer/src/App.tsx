import { useState } from 'react';
import { cx } from './components/ui';
import SettingsScreen, { type SettingsTab } from './screens/settings/SettingsScreen';
import JobsScreen from './screens/jobs/JobsScreen';
import ProfilesScreen from './screens/profiles/ProfilesScreen';
import CollectScreen from './screens/collect/CollectScreen';
import ResultsScreen from './screens/results/ResultsScreen';
import UsageScreen from './screens/usage/UsageScreen';

export type Screen = 'jobs' | 'collect' | 'results' | 'profiles' | 'usage' | 'settings';
export type Navigate = (screen: Screen, opts?: { settingsTab?: SettingsTab }) => void;

const NAV: { key: Screen; label: string }[] = [
  { key: 'collect', label: 'Collect' },
  { key: 'jobs', label: 'Jobs & Analyze' },
  { key: 'profiles', label: 'Profiles' },
  { key: 'results', label: 'Results' },
  { key: 'usage', label: 'Usage' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('collect');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('keys');

  const navigate: Navigate = (s, opts) => {
    if (opts?.settingsTab) setSettingsTab(opts.settingsTab);
    setScreen(s);
  };

  return (
    <div className="flex h-full">
      <nav className="flex w-48 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-4 py-4 text-base font-bold text-indigo-700">Job Matcher</div>
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => navigate(n.key)}
            className={cx(
              'mx-2 mb-0.5 rounded-md px-3 py-2 text-left text-sm font-medium',
              screen === n.key ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">
        {screen === 'settings' ? (
          <SettingsScreen initialTab={settingsTab} />
        ) : screen === 'jobs' ? (
          <JobsScreen navigate={navigate} />
        ) : screen === 'profiles' ? (
          <ProfilesScreen />
        ) : screen === 'collect' ? (
          <CollectScreen navigate={navigate} />
        ) : screen === 'results' ? (
          <ResultsScreen navigate={navigate} />
        ) : (
          <UsageScreen navigate={navigate} />
        )}
      </main>
    </div>
  );
}
