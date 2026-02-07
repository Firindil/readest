import React from 'react';
import { usePluginStore } from '@/store/pluginStore';
import { useTranslation } from '@/hooks/useTranslation';

const PluginSettingsPanel: React.FC = () => {
  const _ = useTranslation();
  const { pluginCount, pluginSettingsPages, initialized } = usePluginStore();

  if (!initialized) {
    return (
      <div className='p-4 text-sm text-base-content/50'>{_('Plugin system not initialized')}</div>
    );
  }

  return (
    <div className='p-4'>
      <div className='mb-4 text-sm font-medium'>
        {_('Plugins')} ({pluginCount})
      </div>
      {pluginCount === 0 ? (
        <div className='text-sm text-base-content/50'>{_('No plugins installed')}</div>
      ) : (
        <div className='space-y-3'>
          {Array.from(pluginSettingsPages.entries()).map(
            ([pluginId, { component: SettingsComponent }]) => (
              <div key={pluginId} className='rounded-lg border border-base-300 p-3'>
                <div className='mb-2 text-sm font-medium'>{pluginId}</div>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <SettingsComponent api={null as any} settings={{}} onChange={(_key: string, _value: unknown) => {}} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
};

export default PluginSettingsPanel;
