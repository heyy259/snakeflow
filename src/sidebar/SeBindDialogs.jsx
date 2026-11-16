import { useEffect, useState } from 'react';
import PackageImportDialog from './PackageImportDialog.jsx';
import ModalOverlay from '../components/ModalOverlay.jsx';

// SE 绑定相关对话框（期 2）：
// - NewTabDialog：新标签页二选（从配置包创建 / 连接或启动系统）§5.2
//
// 所有系统操作经 api 回调上抛给 App（token 永不出 Node，前端只调 /api/se/*）。
// D 收口：alive-unauthed / 「粘贴 token」已取消——存活残留由 Node 侧 spawn 回收重拉，无需用户粘贴。

/**
 * 新标签页二选对话框。api 由 App 注入：
 * listSystems / pickPackage / prepareSystem / bind
 */
export function NewTabDialog({ api, onClose }) {
  const [view, setView] = useState('choose'); // choose | system | busy | error
  const [systems, setSystems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [newId, setNewId] = useState('');
  const [busyText, setBusyText] = useState('');
  const [error, setError] = useState('');
  const [picked, setPicked] = useState(null);
  // identity-mismatch 的显式修复动作（绝不静默改写 id）：{ canonical, payload }。
  const [repair, setRepair] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await api.listSystems();
        if (!cancelled) setSystems(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) setSystems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅挂载时拉取一次系统列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishBind = async (payload, { created = false } = {}) => {
    setView('busy');
    setBusyText('正在完成绑定…');
    const res = await api.bind({ ...payload, requireConnected: created });
    if (res && res.ok && res.connected !== false) {
      onClose();
      return;
    }
    // create 成功但连接失败：终止刚创建、尚未被 tab 接管的系统，避免无主实例。
    if (created && api.endUnboundSystem) {
      await api.endUnboundSystem(payload.systemId).catch(() => {});
    }
    setError(
      (res && (res.error || (res.connected === false ? '系统连接失败' : ''))) ||
        (created ? '系统创建后连接失败' : '绑定失败')
    );
    setView('error');
  };

  const runPrepare = async (payload) => {
    setError('');
    setRepair(null);
    setView('busy');
    setBusyText(payload.importPackage ? '正在启动系统并导入配置包…' : '正在连接或启动系统…');
    const prep = await api.prepareSystem(payload.systemId);
    if (prep && prep.ok) {
      await finishBind(payload);
      return;
    }
    // 大小写别名：磁盘真实 id 与请求不一致。给一次性显式修复，不静默改写。
    if (prep && prep.status === 'identity-mismatch' && prep.canonical) {
      setRepair({ canonical: prep.canonical, payload });
      setError(`系统 id 与磁盘不一致：磁盘上是「${prep.canonical}」。`);
    } else {
      // D：alive-unauthed 已取消——存活残留由 Node 侧 spawn 回收重拉；
      // 失败（含 owned-by-other-vite / port-unverifiable / storage-root-busy）直接给诚实错误。
      setError((prep && prep.error) || '系统启动失败');
    }
    setView('error');
  };

  const onPickPackage = async () => {
    setError('');
    try {
      const result = await api.pickPackage();
      if (!result) return;
      setPicked(result);
      setView('preview');
    } catch (err) {
      setError((err && err.message) || String(err));
      setView('error');
    }
  };

  const onPreviewConfirm = async (payload) => {
    if (!picked) return;
    if (!api.createSystem) {
      setError('当前客户端不支持新建系统接口');
      setView('error');
      return;
    }
    setError('');
    setView('busy');
    setBusyText('正在分配新系统并导入…');
    const created = await api.createSystem({ base: picked.baseName });
    if (!created || !created.ok) {
      setError((created && created.error) || '系统创建失败');
      setView('error');
      return;
    }
    await finishBind(
      {
        systemId: created.systemId,
        displayName: picked.displayName,
        manifestPath: picked.manifestPath,
        storageDir: `se-systems/${created.systemId}`,
        importPackage: {
          manifest: picked.manifest,
          contents: picked.contents,
          planInputs: picked.planInputs,
          selection: payload.selection,
          strategy: payload.strategy,
          restoreLayout: payload.restoreLayout,
        },
      },
      { created: true }
    );
  };

  const onStartSelected = async () => {
    const id = String(selected || newId || '').trim();
    if (!id) {
      setError('请选择或输入系统 id');
      setView('error');
      return;
    }
    await runPrepare({
      systemId: id,
      displayName: id,
      manifestPath: null,
      storageDir: `se-systems/${id}`,
      importPackage: null,
    });
  };

  if (view === 'busy') {
    return (
      <ModalOverlay>
        <div className="modal newtab-dialog">
          <h3>请稍候</h3>
          <div className="dlg-note">{busyText}</div>
        </div>
      </ModalOverlay>
    );
  }

  if (view === 'preview' && picked) {
    const layout = picked.manifest ? picked.manifest.layout : null;
    return (
      <PackageImportDialog
        mode="new-tab"
        targetLabel={picked.displayName}
        plan={picked.plan}
        hasPositions={!!(layout && Object.keys(layout).length)}
        boundPath={null}
        selectedPath={picked.manifestPath}
        busy={false}
        progress={null}
        onConfirm={onPreviewConfirm}
        onClose={() => {
          setPicked(null);
          setView('choose');
        }}
      />
    );
  }

  if (view === 'error') {
    return (
      <ModalOverlay onCancel={onClose} closeOnEsc>
        <div className="modal newtab-dialog">
          <h3>操作失败</h3>
          <div className="dlg-err">{error}</div>
          <div className="dlg-actions">
            {repair ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const target = repair;
                  setRepair(null);
                  runPrepare({ ...target.payload, systemId: target.canonical });
                }}
              >
                改用「{repair.canonical}」连接
              </button>
            ) : null}
            <button type="button" onClick={() => { setError(''); setView('choose'); }}>
              返回
            </button>
            <button type="button" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  if (view === 'system') {
    return (
      <ModalOverlay onCancel={onClose} closeOnEsc>
        <div className="modal newtab-dialog">
          <h3>连接或启动系统</h3>
          <div className="newtab-systems">
            {loading && <div className="dlg-note">正在读取系统列表…</div>}
            {!loading && systems.length === 0 && (
              <div className="dlg-note">未发现已注册系统（可输入新系统 id 启动）。</div>
            )}
            {systems.map((s) => (
              <label
                key={s.system_id}
                className={'newtab-sys-row' + (selected === s.system_id ? ' selected' : '')}
              >
                <input
                  type="radio"
                  name="se-system"
                  checked={selected === s.system_id}
                  onChange={() => {
                    setSelected(s.system_id);
                    setNewId('');
                  }}
                />
                <span className="newtab-sys-id">{s.system_id}</span>
                <span className="newtab-sys-meta">
                  端口 {s.port} · {s.alive ? '存活' : '未存活'}
                </span>
              </label>
            ))}
          </div>
          <div className="dlg-row">
            <input
              type="text"
              placeholder="或输入新系统 id 并启动"
              value={newId}
              onChange={(e) => {
                setNewId(e.target.value);
                setSelected('');
              }}
            />
          </div>
          <div className="dlg-actions">
            <button type="button" className="primary" onClick={onStartSelected}>
              {selected && systems.find((x) => x.system_id === selected)?.alive
                ? '连接'
                : '启动'}
            </button>
            <button
              type="button"
              onClick={() => {
                setView('choose');
                setError('');
              }}
            >
              返回
            </button>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay onCancel={onClose} closeOnEsc>
      <div className="modal newtab-dialog">
        <h3>新建标签页</h3>
        <div className="newtab-choices">
          <button type="button" className="newtab-choice newtab-choice-package" onClick={onPickPackage}>
            <strong>从配置包创建</strong>
            <span>选择 &lt;名字&gt;.se.json，预览后新建独占 SE 系统并全量导入</span>
          </button>
          <button
            type="button"
            className="newtab-choice newtab-choice-system"
            onClick={() => {
              setError('');
              setView('system');
            }}
          >
            <strong>连接或启动系统</strong>
            <span>从已有系统列表 attach，或启动一个新系统</span>
          </button>
        </div>
        <div className="dlg-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
