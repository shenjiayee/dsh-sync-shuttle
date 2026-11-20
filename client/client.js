// 客户端 UI：左侧栏独立页面「穿梭 · 同步中转」。
//
// 结构沿用 ifos-monitor 的做法：整体包在 window.__ModuleLoader__.load 里，
// 内部用 CJS 风格 require('react')，末尾导出 apply / inject。
//
// 设计约束（§7）：
//   · 颜色一律走 --dsw-alias-* 主题变量，不写死
//   · 浏览清单绝不持锁，写操作才持锁
//   · 长任务用「启动 → 轮询 job.status」，不阻塞界面

window.__ModuleLoader__.load({
  id: 'dsh-sync-shuttle',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = require('react');

    const PANEL_ID = 'sync-shuttle';
    const CHANNEL = '/sync-shuttle';

    const EP = {
      status: 'status.get',
      settings: 'settings.get',
      credentialsSave: 'credentials.save',
      credentialsClear: 'credentials.clear',
      testConnection: 'connection.test',
      projectsList: 'projects.list',
      projectCreate: 'project.create',
      projectBind: 'project.bind',
      projectDelete: 'project.delete',
      projectKeepPrev: 'project.keepPrev',
      projectCleanResidue: 'project.cleanResidue',
      uploadStart: 'upload.start',
      downloadStart: 'download.start',
      jobStatus: 'job.status',
      lockStatus: 'lock.status',
      configBackups: 'config.backups',
      configBackupNow: 'config.backupNow',
      configRestore: 'config.restore',
      capacityGet: 'capacity.get',
    };

    const S = {
      page: {
        padding: '20px 24px',
        maxWidth: '1080px',
        margin: '0 auto',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        fontFamily: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
      h1: { fontSize: '20px', fontWeight: 600, margin: 0 },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 12px' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        borderRadius: '10px',
        padding: '16px',
        marginBottom: '14px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' },
      label: { minWidth: '96px', color: 'var(--dsw-alias-label-secondary, #4e5969)', fontSize: '13px' },
      input: {
        flex: 1,
        minWidth: '220px',
        padding: '7px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #d0d3d9)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        fontSize: '13px',
        fontFamily: 'inherit',
      },
      btn: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      btnPrimary: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-brand-primary, #165dff)',
        background: 'var(--dsw-alias-brand-primary, #165dff)',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
      },
      btnDanger: {
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-state-error-primary, #f53f3f)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #f53f3f)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      note: { color: 'var(--dsw-alias-label-tertiary, #86909c)', fontSize: '12px' },
      err: { color: 'var(--dsw-alias-state-error-primary, #f53f3f)', fontSize: '12px', whiteSpace: 'pre-wrap' },
      ok: { color: 'var(--dsw-alias-brand-primary, #165dff)', fontSize: '12px' },
      chip: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        color: 'var(--dsw-alias-label-secondary, #4e5969)',
      },
      chipOk: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-brand-primary, #165dff)',
        color: 'var(--dsw-alias-brand-primary, #165dff)',
      },
      chipErr: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-state-error-primary, #f53f3f)',
        color: 'var(--dsw-alias-state-error-primary, #f53f3f)',
      },
      projectCard: {
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        borderRadius: '8px',
        padding: '12px 14px',
        marginBottom: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      projectCardUnbound: {
        border: '1px dashed var(--dsw-alias-border-l2, #d0d3d9)',
        borderRadius: '8px',
        padding: '12px 14px',
        marginBottom: '10px',
        background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      },
      projectCardLocalOnly: {
        border: '1px dashed var(--dsw-alias-brand-primary, #165dff)',
        borderRadius: '8px',
        padding: '12px 14px',
        marginBottom: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      bar: {
        height: '6px',
        borderRadius: '3px',
        background: 'var(--dsw-alias-bg-layer-2, #f2f3f5)',
        overflow: 'hidden',
        marginTop: '6px',
      },
      barInner: { height: '100%', background: 'var(--dsw-alias-brand-primary, #165dff)', transition: 'width .2s' },
      // 容量条分档着色（§5）：80% 黄、90% 橙、100% 红
      barWarn: { height: '100%', background: 'var(--dsw-alias-state-warning-primary, #ff7d00)', transition: 'width .2s' },
      barHigh: { height: '100%', background: '#ff9a2e', transition: 'width .2s' },
      barFull: { height: '100%', background: 'var(--dsw-alias-state-error-primary, #f53f3f)', transition: 'width .2s' },
      pre: {
        background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        borderRadius: '6px',
        padding: '10px',
        fontSize: '12px',
        maxHeight: '220px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        margin: 0,
      },
      tabs: { display: 'flex', gap: '6px', marginBottom: '14px' },
      tab: {
        padding: '6px 14px',
        borderRadius: '6px',
        fontSize: '13px',
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #4e5969)',
      },
      tabActive: {
        padding: '6px 14px',
        borderRadius: '6px',
        fontSize: '13px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        fontWeight: 600,
      },
    };

    function fmtBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let x = v / 1024;
      let i = 0;
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i += 1;
      }
      return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
    }

    function fmtTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function SyncShuttleIcon() {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M4 8h13l-3-3' }),
        h('path', { d: 'M20 16H7l3 3' }),
      );
    }

    function StatusBar({ status, lock, onRefresh, busy }) {
      const lockText = (() => {
        if (!status?.configured) return '未配置邮箱';
        if (!lock) return '锁状态未知';
        if (lock.error) return `锁状态异常：${lock.error}`;
        if (lock.isMine) return `🔴 我正在操作（剩 ${Math.ceil((lock.remainingMs || 0) / 1000)} 秒）`;
        if (lock.free) return '🟢 空闲';
        return `🟡 ${lock.holder?.owner || '另一台电脑'} 正在${lock.holder?.op || '操作'}`;
      })();
      return h(
        'div',
        { style: { ...S.card, padding: '10px 14px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '13px' } }, lockText),
        h('span', { style: S.note }, `本机 ${status?.machineId || '-'} · ${status?.hostname || ''}`),
        status?.account ? h('span', { style: S.note }, `账号 ${status.account}`) : null,
        h('span', { style: { flex: 1 } }),
        h('button', { style: S.btn, onClick: onRefresh, disabled: busy }, busy ? '刷新中…' : '刷新'),
      );
    }

    function ProjectsTab({ list, onUpload, onDownload, onBind, onCreate, onDelete, onKeepPrev, onCleanResidue, currentJob, remoteBusy }) {
      const projects = list?.projects || [];
      const [newName, setNewName] = useState('');
      const [newDir, setNewDir] = useState('');
      const [bindTarget, setBindTarget] = useState(null);
      const [bindDir, setBindDir] = useState('');
      const [msg, setMsg] = useState(null);

      const capacity = list
        ? `${fmtBytes(list.occupiedBytes)} / ${fmtBytes(list.capacityBytes)}`
        : '-';
      // 容量百分比：80% 黄 / 90% 橙 / 100% 红（§5）
      const capPct =
        list && list.capacityBytes > 0
          ? Math.min(100, Math.round((Number(list.occupiedBytes || 0) / list.capacityBytes) * 100))
          : 0;
      const capBarStyle = capPct >= 100 ? S.barFull : capPct >= 90 ? S.barHigh : capPct >= 80 ? S.barWarn : S.barInner;
      const capHint =
        capPct >= 100
          ? '容量已达上限，上传会被拒绝：请先删除旧项目或调高容量设置'
          : capPct >= 90
            ? '容量接近上限（90% 以上）'
            : capPct >= 80
              ? '容量已用 80% 以上，请注意'
              : '';

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '邮箱占用'),
          h(
            'div',
            { style: S.row },
            h('span', { style: { fontSize: '13px' } }, capacity),
            h('span', { style: S.note }, 'ⓘ 仅统计本插件占用（QQ 不提供 QUOTA 接口，真实用量请查网页版）'),
          ),
          list && list.capacityBytes > 0
            ? h(
                'div',
                { style: S.bar },
                h('div', { style: { ...capBarStyle, width: `${capPct}%` } }),
              )
            : null,
          capHint ? h('div', { style: { ...S.note, marginTop: '4px' } }, `${capPct}% · ${capHint}`) : null,
          list?.recovered
            ? h(
                'div',
                { style: S.ok },
                `已从 ${fmtTime(list.recovered.at)} 的远端备份恢复本机配置（${list.recovered.count} 个项目）`,
              )
            : null,
          list?.remoteError
            ? h('div', { style: S.err }, `读取远端失败：${list.remoteError.message}`)
            : null,
        ),

        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, `项目清单（${projects.length}）`),
          projects.length === 0
            ? h('div', { style: S.note }, '还没有项目。先在下面新建一个，或等另一台电脑上传后在这里刷新。')
            : null,
          projects.map((p) => {
            const style =
              p.state === 'unbound'
                ? S.projectCardUnbound
                : p.state === 'local-only'
                  ? S.projectCardLocalOnly
                  : S.projectCard;
            return h(
              'div',
              { key: p.project, style },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: '14px' } }, p.project),
                p.state === 'unbound'
                  ? h('span', { style: S.chip }, '待绑定')
                  : p.state === 'local-only'
                    ? h('span', { style: S.chip }, '未上传')
                    : h('span', { style: S.chipOk }, '已联动'),
                p.latest
                  ? p.latest.status === 'complete'
                    ? h('span', { style: S.chipOk }, '远端完整')
                    : h('span', { style: S.chipErr }, p.latest.status === 'missing' ? `缺第 ${p.latest.missing.join('、')} 卷` : '字节数不符')
                  : null,
                p.latest ? h('span', { style: S.note }, `${p.latest.sizeText} · ${p.latest.volumes} 卷 · ${fmtTime(p.latest.uploadedAt)}`) : null,
                p.latest?.encrypted ? h('span', { style: S.chip }, '加密') : null,
              ),
              h('div', { style: { ...S.note, marginTop: '6px' } }, p.localDir ? `本地：${p.localDir}` : '本地：未绑定'),
              p.history && p.history.length
                ? h(
                    'div',
                    { style: { ...S.note, marginTop: '6px' } },
                    p.history.map((v) =>
                      h('div', { key: v.versionId }, `├ ${v.version} ${fmtTime(v.uploadedAt)} ${v.sizeText} / ${v.volumes} 卷`),
                    ),
                    h('div', null, '└ 下次上传后将按「保留上一版」设置清理'),
                  )
                : null,
              h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                p.bound
                  ? h(
                      'button',
                      {
                        style: S.btnPrimary,
                        onClick: () => onUpload(p.project),
                        disabled: Boolean(currentJob) || Boolean(remoteBusy),
                        title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                      },
                      '上传',
                    )
                  : null,
                p.latest && p.bound
                  ? h(
                      'button',
                      {
                        style: S.btn,
                        onClick: () => onDownload(p.project, p.latest.versionId),
                        disabled: Boolean(currentJob) || Boolean(remoteBusy),
                        title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                      },
                      '下载并镜像',
                    )
                  : null,
                p.state === 'unbound'
                  ? h(
                      'button',
                      { style: S.btnPrimary, onClick: () => { setBindTarget(p.project); setBindDir(''); } },
                      '绑定本地目录',
                    )
                  : h(
                      'button',
                      { style: S.btn, onClick: () => { setBindTarget(p.project); setBindDir(p.localDir || ''); } },
                      '改目录',
                    ),
                p.latest
                  ? h(
                      'button',
                      {
                        style: S.btn,
                        onClick: () => onDownload(p.project),
                        disabled: Boolean(currentJob) || Boolean(remoteBusy),
                        title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                      },
                      '下载最新',
                    )
                  : null,
                h(
                  'button',
                  {
                    style: S.btn,
                    // 开关是「本机偏好」，必须已绑定目录才能改（要落进 projects.json）
                    disabled: !p.bound,
                    title: p.bound ? '下一次上传后生效' : '请先绑定本地目录',
                    onClick: () => onKeepPrev(p.project, !p.keepPrev),
                  },
                  p.keepPrev ? '✓ 保留上一版' : '保留上一版',
                ),
                h('button', { style: S.btn, onClick: () => onCleanResidue(p.project) }, '清理残留'),
                h('button', { style: S.btnDanger, onClick: () => onDelete(p.project) }, '删除'),
              ),
            );
          }),
          bindTarget
            ? h(
                'div',
                { style: { ...S.card, background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)' } },
                h('div', { style: { fontSize: '13px', marginBottom: '8px' } }, `为「${bindTarget}」绑定本地目录`),
                h('input', {
                  style: S.input,
                  value: bindDir,
                  placeholder: '例如 D:\\同步\\照片',
                  onChange: (e) => setBindDir(e.target.value),
                }),
                h(
                  'div',
                  { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    {
                      style: S.btnPrimary,
                      onClick: async () => {
                        const r = await onBind(bindTarget, bindDir);
                        setMsg(r);
                        if (r?.ok) setBindTarget(null);
                      },
                    },
                    '保存',
                  ),
                  h('button', { style: S.btn, onClick: () => setBindTarget(null) }, '取消'),
                ),
              )
            : null,
        ),

        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '新建项目'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '项目名'),
            h('input', { style: S.input, value: newName, onChange: (e) => setNewName(e.target.value), placeholder: '例如 照片归档' }),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '本地目录'),
            h('input', { style: S.input, value: newDir, onChange: (e) => setNewDir(e.target.value), placeholder: '例如 D:\\同步\\照片' }),
          ),
          h(
            'button',
            {
              style: S.btnPrimary,
              onClick: async () => {
                const r = await onCreate(newName.trim(), newDir.trim());
                setMsg(r);
                if (r?.ok) {
                  setNewName('');
                  setNewDir('');
                }
              },
            },
            '创建',
          ),
          msg ? h('div', { style: msg.ok ? S.ok : S.err, marginTop: '8px' }, msg.text) : null,
          h('div', { style: { ...S.note, marginTop: '8px' } }, '项目名区分大小写与全半角，一旦创建不要随意改名。'),
        ),
      );
    }

    /** 分区通用的「选一个已绑定项目」选择器。 */
    function ProjectPicker({ projects, value, onChange, placeholder }) {
      if (!projects.length) {
        return h('div', { style: S.note }, placeholder || '还没有已绑定的项目，请先去「项目」分区绑定本地目录。');
      }
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.label }, '项目'),
        h(
          'select',
          { style: S.input, value: value || '', onChange: (e) => onChange(e.target.value) },
          projects.map((p) => h('option', { key: p.project, value: p.project }, p.project)),
        ),
      );
    }

    /** ② 上传分区：选项目 → 打包上传 → 进度 + 卷列表 + 回读校验结果。 */
    function UploadTab({ list, onUpload, job, onDismissJob, onResolveJob, remoteBusy }) {
      const projects = (list?.projects || []).filter((p) => p.bound);
      const [name, setName] = useState(projects[0]?.project || '');
      const target = projects.find((p) => p.project === name) || projects[0] || null;
      const active = job && job.kind === 'upload' ? job : null;
      const running = Boolean(active && active.status === 'running');

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '上传（整目录快照）'),
          h(ProjectPicker, {
            projects,
            value: target?.project,
            onChange: setName,
            placeholder: '还没有已绑定的项目，请先去「项目」分区绑定本地目录。',
          }),
          target
            ? h(
                'div',
                { style: { ...S.note, marginTop: '6px' } },
                `本地：${target.localDir}`,
              )
            : null,
          target
            ? h(
                'div',
                { style: { ...S.note, marginTop: '4px' } },
                target.latest
                  ? `远端最新：${target.latest.version} · ${target.latest.sizeText} · ${target.latest.volumes} 卷（${fmtTime(target.latest.uploadedAt)}）`
                  : '远端还没有这个项目的任何版本',
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                style: S.btnPrimary,
                disabled: !target || running || Boolean(remoteBusy),
                title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                onClick: () => target && onUpload(target.project),
              },
              running ? '上传中…' : '开始上传',
            ),
            target && target.keepPrev
              ? h('span', { style: { ...S.note, alignSelf: 'center' } }, '已开启「保留上一版」：本次上传后会保留最近 2 个版本')
              : h('span', { style: { ...S.note, alignSelf: 'center' } }, '默认只保留最新 1 个版本（可在「项目」分区开启保留上一版）'),
          ),
          h(
            'div',
            { style: { ...S.note, marginTop: '8px' } },
            '上传会先打包成 7z 分卷，逐卷计算 SHA-256 后写入邮箱，再回读逐卷校验；校验通过前不会删除任何旧版本。',
          ),
        ),
        active
          ? h('div', { style: { marginTop: '10px' } }, h(JobPanel, { job: active, onDismiss: onDismissJob, onResolve: onResolveJob }))
          : null,
      );
    }

    /** ③ 下载分区：选项目 → 完整性检查 → 下载/校验/解包 → 覆盖确认 → 结果报告。 */
    function DownloadTab({ list, onDownload, job, onDismissJob, onResolveJob, remoteBusy }) {
      const projects = list?.projects || [];
      const [name, setName] = useState(projects[0]?.project || '');
      const target = projects.find((p) => p.project === name) || projects[0] || null;
      const active = job && job.kind === 'download' ? job : null;
      const running = Boolean(active && active.status === 'running');
      const versions = target ? [target.latest, ...(target.history || [])].filter(Boolean) : [];

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '下载（镜像覆盖）'),
          h(ProjectPicker, { projects, value: target?.project, onChange: setName }),
          target && !target.bound
            ? h(
                'div',
                { style: S.err, marginTop: '6px' },
                '这个项目还没有绑定本地目录，下载前请先在「项目」分区绑定。',
              )
            : null,
          target
            ? h(
                'div',
                { style: { ...S.row, marginTop: '8px' } },
                h('span', { style: S.label }, '目标目录'),
                h('span', { style: { fontSize: '13px' } }, target.localDir || '未绑定'),
              )
            : null,
          versions.length === 0
            ? h('div', { style: { ...S.note, marginTop: '8px' } }, '远端还没有任何版本可以下载。')
            : h(
                'div',
                { style: { marginTop: '10px' } },
                versions.map((v, i) =>
                  h(
                    'div',
                    {
                      key: v.versionId,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                        padding: '6px 0',
                        borderTop: i === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
                      },
                    },
                    i === 0 ? h('span', { style: S.chipOk }, '最新') : h('span', { style: S.chip }, '历史'),
                    h('span', { style: { fontSize: '13px' } }, `${v.version} · ${v.sizeText} · ${v.volumes} 卷`),
                    v.status === 'complete'
                      ? h('span', { style: S.chipOk }, '完整')
                      : h('span', { style: S.chipErr }, v.status === 'missing' ? `缺第 ${(v.missing || []).join('、')} 卷` : '字节数不符'),
                    v.encrypted ? h('span', { style: S.chip }, '加密') : null,
                    h('span', { style: { flex: 1 } }),
                    h(
                      'button',
                      {
                        style: S.btn,
                        disabled: !target?.bound || running || Boolean(remoteBusy),
                        title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                        onClick: () => target && onDownload(target.project, v.versionId),
                      },
                      '下载并镜像',
                    ),
                  ),
                ),
              ),
          h(
            'div',
            { style: { ...S.note, marginTop: '8px' } },
            '下载会先校验远端完整性，再逐卷下载并比对 SHA-256，合并后校验整包哈希；改动本地文件前一定会先弹确认框，可勾选「先备份再覆盖」。',
          ),
        ),
        active
          ? h('div', { style: { marginTop: '10px' } }, h(JobPanel, { job: active, onDismiss: onDismissJob, onResolve: onResolveJob }))
          : null,
        active && active.status === 'done' && active.result
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, '结果报告'),
              h('div', { style: { fontSize: '13px' } }, `目标目录：${active.result.targetDir}`),
              h(
                'div',
                { style: { ...S.note, marginTop: '4px' } },
                `新建 ${active.result.created} / 覆盖 ${active.result.overwritten} / 未变 ${active.result.unchanged ?? 0} / 删除 ${active.result.deleted} 个文件 · ${fmtBytes(active.result.bytes)}`,
              ),
              active.result.skippedVolumes?.length
                ? h('div', { style: { ...S.note, marginTop: '4px' } }, `复用已下载分卷：${active.result.skippedVolumes.length} 卷`)
                : null,
              active.result.backupDir
                ? h('div', { style: { ...S.note, marginTop: '4px' } }, `已备份待删文件到：${active.result.backupDir}`)
                : null,
              active.result.missingAfter?.length
                ? h('div', { style: S.err, marginTop: '4px' }, `解包后仍缺少 ${active.result.missingAfter.length} 个文件：${active.result.missingAfter.slice(0, 10).join('、')}`)
                : null,
              active.result.extraAfter?.length
                ? h('div', { style: S.err, marginTop: '4px' }, `解包后仍多余 ${active.result.extraAfter.length} 个文件：${active.result.extraAfter.slice(0, 10).join('、')}`)
                : null,
            )
          : null,
      );
    }

    function JobPanel({ job, onDismiss, onResolve }) {
      const [pass, setPass] = useState('');
      if (!job) return null;
      const color =
        job.status === 'failed'
          ? S.err
          : job.status === 'done'
            ? S.ok
            : { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #4e5969)' };
      const needCode = job.status === 'need-input' ? job.error?.code : null;
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('strong', null, job.kind === 'upload' ? '上传中' : '下载中'),
          h('span', { style: S.note }, job.project),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.note }, job.elapsedText),
          h('button', { style: S.btn, onClick: onDismiss }, '收起'),
        ),
        h('div', { style: color, marginTop: '8px' }, job.message),
        typeof job.percent === 'number' && job.status === 'running'
          ? h('div', { style: S.bar }, h('div', { style: { ...S.barInner, width: `${job.percent}%` } }))
          : null,
        // 加密支持已移除（方案 A3），不再有口令输入分支。
        needCode === 'NEED_CONFIRM'
          ? h(
              'div',
              { style: { ...S.card, background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)', marginTop: '10px' } },
              h('div', { style: S.err }, job.error?.message || '需要确认'),
              job.error?.plan
                ? h(
                    'div',
                    { style: { ...S.note, marginTop: '6px' } },
                    `将写入 ${job.error.plan.incomingFiles} 个文件，覆盖 ${job.error.plan.toOverwrite} 个，删除 ${job.error.plan.toDeleteCount} 个（${fmtBytes(job.error.plan.toDeleteBytes)}）`,
                    job.error.plan.toDelete?.length
                      ? h(
                          'div',
                          { style: { marginTop: '4px', wordBreak: 'break-all' } },
                          `将删除：${job.error.plan.toDelete.slice(0, 30).join('、')}${job.error.plan.toDeleteCount > 30 ? ' …' : ''}`,
                        )
                      : null,
                  )
                : null,
              h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                h('button', { style: S.btnPrimary, onClick: () => onResolve({ confirm: true }) }, '确认镜像覆盖'),
                h(
                  'button',
                  { style: S.btn, onClick: () => onResolve({ confirm: true, backupBeforeDelete: true }) },
                  '先备份再覆盖',
                ),
                h('button', { style: S.btn, onClick: onDismiss }, '取消'),
              ),
            )
          : null,
        job.log && job.log.length
          ? h('pre', { style: { ...S.pre, marginTop: '10px' } }, job.log.map((l) => l.message).join('\n'))
          : null,
      );
    }

    function SettingsTab({ settings, onSave, onTest, status }) {
      const [account, setAccount] = useState('');
      const [token, setToken] = useState('');
      const [msg, setMsg] = useState(null);
      const [testing, setTesting] = useState(false);
      const [backups, setBackups] = useState(null);

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '邮箱连接'),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '邮箱地址'),
            h('input', { style: S.input, value: account, onChange: (e) => setAccount(e.target.value), placeholder: '例如 someone@qq.com' }),
          ),
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '授权码'),
            h('input', {
              style: S.input,
              type: 'password',
              value: token,
              onChange: (e) => setToken(e.target.value),
              placeholder: '16 位授权码（不是登录密码）',
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                style: S.btnPrimary,
                onClick: async () => {
                  const r = await onSave(account.trim(), token.trim());
                  setMsg(r);
                  if (r?.ok) setToken('');
                },
              },
              '保存',
            ),
            h(
              'button',
              {
                style: S.btn,
                onClick: async () => {
                  setTesting(true);
                  const r = await onTest();
                  setTesting(false);
                  setMsg(r);
                },
              },
              testing ? '测试中…' : '测试连接',
            ),
          ),
          h(
            'div',
            { style: { ...S.note, marginTop: '10px' } },
            '授权码在邮箱网页版「设置 → 账号 → POP3/IMAP/SMTP 服务」里开启 IMAP 后生成；只显示一次，丢了只能新增一个。' +
              '授权码保存在本机 credentials.json（不进配置、不进 git）。',
          ),
          msg ? h('div', { style: msg.ok ? S.ok : S.err, marginTop: '8px' }, msg.text) : null,
        ),

        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '运行参数（只读）'),
          settings
            ? h(
                'div',
                null,
                h('div', { style: S.row }, h('span', { style: S.label }, 'IMAP'), h('span', { style: { fontSize: '13px' } }, `${settings.imapHost}:${settings.imapPort}`)),
                h('div', { style: S.row }, h('span', { style: S.label }, '分卷大小'), h('span', { style: { fontSize: '13px' } }, `${settings.volumeMiB} MiB`)),
                h('div', { style: S.row }, h('span', { style: S.label }, '归档格式'), h('span', { style: { fontSize: '13px' } }, 'ZIP（内置，无需安装 7-Zip）')),
                h('div', { style: S.row }, h('span', { style: S.label }, '分卷命名'), h('span', { style: { fontSize: '13px' } }, '<版本>.001 / .002 / …')),
                h('div', { style: S.row }, h('span', { style: S.label }, '数据目录'), h('span', { style: { fontSize: '13px' } }, settings.dataDir)),
                h('div', { style: S.row }, h('span', { style: S.label }, '锁租期'), h('span', { style: { fontSize: '13px' } }, `${Math.round(settings.lockTtlMs / 1000)} 秒`)),
              )
            : h('div', { style: S.note }, '加载中…'),
          h('div', { style: { ...S.note, marginTop: '8px' } }, '这些值来自 profile 的 cordis.patch.yml，改配置后重启 DSH 生效。'),
        ),

        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '远端配置备份'),
          h(
            'div',
            { style: { ...S.note, marginBottom: '8px' } },
            status
              ? `本机身份：${status.machineId || '-'}（${status.hostname || ''}）`
              : '本机身份加载中…',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                style: S.btn,
                onClick: async () => {
                  const r = await onTest('backupNow');
                  setMsg(r);
                },
              },
              '立即备份',
            ),
            h(
              'button',
              {
                style: S.btn,
                onClick: async () => {
                  const r = await onTest('backups');
                  if (r?.ok) setBackups(r.value?.backups || []);
                  else setMsg(r);
                },
              },
              '查看远端备份列表',
            ),
          ),
          backups
            ? h(
                'div',
                { style: { marginTop: '10px' } },
                backups.length === 0 ? h('div', { style: S.note }, '远端还没有任何配置备份') : null,
                backups.map((b) =>
                  h(
                    'div',
                    { key: `${b.machineId}-${b.seq}`, style: { ...S.row, marginTop: '4px' } },
                    h('span', { style: { fontSize: '13px' } }, `${b.machineId}${b.isMine ? '（本机）' : ''} · ${b.hostname} · ${fmtTime(b.at)}`),
                    h('span', { style: { flex: 1 } }),
                    h(
                      'button',
                      {
                        style: S.btn,
                        onClick: async () => {
                          // 恢复只在「本机备份」上开放：跨机器套用会带来路径全错的绑定表
                          const r = await onTest('restore', { seq: b.seq });
                          if (r?.needConfirm) {
                            const d = r.diff || {};
                            const lines = [
                              `将用 ${fmtTime(r.at)} 的远端备份覆盖当前配置：`,
                              `  将新增：${(d.added || []).length} 个项目${(d.added || []).length ? `（${(d.added || []).join('、')}）` : ''}`,
                              `  将改动：${(d.changed || []).length} 个项目${(d.changed || []).length ? `（${(d.changed || []).join('、')}）` : ''}`,
                              `  将删除：${(d.removed || []).length} 个项目${(d.removed || []).length ? `（${(d.removed || []).join('、')}）` : ''}`,
                              '',
                              '当前配置会先备份为 projects.json.bak-<时间戳>。确定恢复吗？',
                            ];
                            if (!window.confirm(lines.join('\n'))) return;
                            const r2 = await onTest('restore', { seq: b.seq, confirm: true });
                            setMsg(r2?.ok ? { ok: true, text: r2.text } : r2);
                          } else if (r?.ok) {
                            setMsg({ ok: true, text: r.text });
                          } else {
                            setMsg(r);
                          }
                        },
                      },
                      b.isMine ? '从备份恢复' : '恢复（其它机器）',
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { style: { ...S.note, marginTop: '8px' } },
            '本机配置丢失或损坏时，刷新页面会自动从最近一次备份恢复；远端备份永不覆盖本机合法配置。' +
              '手动「从备份恢复」会先展示差异，确认前不会改动任何文件。',
          ),
        ),
      );
    }

    function SyncShuttlePage({ rpc }) {
      const [tab, setTab] = useState('projects');
      const [status, setStatus] = useState(null);
      const [lock, setLock] = useState(null);
      const [list, setList] = useState(null);
      const [settings, setSettings] = useState(null);
      const [job, setJob] = useState(null);
      const [busy, setBusy] = useState(false);
      const pollRef = useRef(null);

      const call = useCallback(
        async (endpoint, payload) => {
          try {
            const r = await rpc(endpoint, payload);
            return r && r.ok ? { ok: true, value: r.value } : { ok: false, text: r?.error?.message || '调用失败', value: null };
          } catch (err) {
            return { ok: false, text: String(err?.message || err), value: null };
          }
        },
        [rpc],
      );

      const refresh = useCallback(async () => {
        setBusy(true);
        const st = await call(EP.status);
        if (st.ok) {
          setStatus(st.value);
          setLock(st.value.lock);
        }
        const ls = await call(EP.projectsList);
        if (ls.ok) setList(ls.value);
        const se = await call(EP.settings);
        if (se.ok) setSettings(se.value.settings);
        setBusy(false);
      }, [call]);

      useEffect(() => {
        refresh();
        return () => {
          if (pollRef.current) clearInterval(pollRef.current);
        };
      }, [refresh]);

      const startPolling = useCallback(
        (jobId) => {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(async () => {
            const r = await call(EP.jobStatus, { jobId });
            if (!r.ok) return;
            setJob(r.value);
            if (['done', 'failed', 'need-input'].includes(r.value.status)) {
              clearInterval(pollRef.current);
              pollRef.current = null;
              if (r.value.status === 'done') refresh();
            }
          }, 800);
        },
        [call, refresh],
      );

      const onUpload = useCallback(
        async (name, extra) => {
          const r = await call(EP.uploadStart, { name, ...(extra || {}) });
          if (!r.ok) {
            setList((prev) => prev);
            window.alert(r.text);
            return;
          }
          setJob({ id: r.value.jobId, kind: 'upload', project: name, status: 'running', stage: 'starting', message: '准备中', percent: 0, log: [] });
          startPolling(r.value.jobId);
        },
        [call, startPolling],
      );

      const onDownload = useCallback(
        async (name, versionId, extra) => {
          const r = await call(EP.downloadStart, { name, versionId, ...(extra || {}) });
          if (!r.ok) {
            window.alert(r.text);
            return;
          }
          setJob({ id: r.value.jobId, kind: 'download', project: name, status: 'running', stage: 'starting', message: '准备中', percent: 0, log: [] });
          startPolling(r.value.jobId);
        },
        [call, startPolling],
      );

      /** need-input 之后带上用户补充的参数重发一次（同一项目、同一版本）。 */
      const onResolveJob = useCallback(
        async (extra) => {
          if (!job) return;
          // 上传也会因「默认加密」停在 need-input，必须按 kind 分流，
          // 否则会拿上传任务去发起一次下载。
          if (job.kind === 'upload') {
            await onUpload(job.project, extra);
            return;
          }
          const versionId = job.error?.versionId || job.versionId || null;
          await onDownload(job.project, versionId, extra);
        },
        [job, onUpload, onDownload],
      );

      const onBind = useCallback(
        async (name, localDir) => {
          const r = await call(EP.projectBind, { name, localDir });
          if (r.ok) refresh();
          return r.ok ? { ok: true, text: r.value.note || '已保存' } : { ok: false, text: r.text };
        },
        [call, refresh],
      );

      const onCreate = useCallback(
        async (name, localDir) => {
          if (!name) return { ok: false, text: '请填写项目名' };
          if (!localDir) return { ok: false, text: '请填写本地目录' };
          const r = await call(EP.projectCreate, { name, localDir });
          if (r.ok) refresh();
          return r.ok ? { ok: true, text: r.value.note || '已创建' } : { ok: false, text: r.text };
        },
        [call, refresh],
      );

      const onDelete = useCallback(
        async (name) => {
          const sure = window.confirm(
            `删除项目「${name}」会同时删除远端所有版本邮件，且不可恢复。\n\n确定删除吗？`,
          );
          if (!sure) return;
          const alsoLocal = window.confirm('是否同时移除本机的目录绑定？（点「取消」= 只删远端，保留本地绑定）');
          const r = await call(EP.projectDelete, { name, removeLocal: alsoLocal });
          if (r.ok) refresh();
          else window.alert(r.text);
        },
        [call, refresh],
      );

      const onKeepPrev = useCallback(
        async (name, keepPrev) => {
          const r = await call(EP.projectKeepPrev, { name, keepPrev });
          if (r.ok) {
            window.alert(r.value.note);
            // 开关已落库，刷新一下让卡片上的状态同步
            refresh();
          } else window.alert(r.text);
        },
        [call, refresh],
      );

      const onCleanResidue = useCallback(
        async (name) => {
          const r = await call(EP.projectCleanResidue, { name });
          if (r.ok) {
            window.alert(r.value.message);
            refresh();
          } else window.alert(r.text);
        },
        [call, refresh],
      );

      const onSaveCreds = useCallback(
        async (account, token) => {
          if (!account || !token) return { ok: false, text: '邮箱地址与授权码都要填' };
          const r = await call(EP.credentialsSave, { account, token });
          if (r.ok) {
            refresh();
            return { ok: true, text: `已保存 ${r.value.accountMasked}` };
          }
          return { ok: false, text: r.text };
        },
        [call, refresh],
      );

      const onTest = useCallback(
        async (what, extra) => {
          if (what === 'backups') {
            const r = await call(EP.configBackups);
            return r.ok ? { ok: true, value: r.value } : { ok: false, text: r.text };
          }
          if (what === 'backupNow') {
            const r = await call(EP.configBackupNow);
            if (!r.ok) return { ok: false, text: r.text };
            // 「立即备份」后本机绑定表没变，但远端多了一份，顺手刷新清单时间
            refresh();
            return { ok: r.value.ok === true, text: r.value.message + (r.value.at ? `（${fmtTime(r.value.at)}）` : '') };
          }
          if (what === 'restore') {
            const r = await call(EP.configRestore, extra || {});
            if (!r.ok) return { ok: false, text: r.text };
            if (r.value?.needConfirm) {
              // 只回报差异，绝不落盘；用户确认后由界面二次调用
              return { ok: true, needConfirm: true, diff: r.value.diff, at: r.value.at };
            }
            refresh();
            return { ok: true, text: '已按备份恢复本机绑定表（原配置已另存为 .bak 文件）' };
          }
          const r = await call(EP.testConnection);
          if (r.ok) {
            return {
              ok: true,
              text: `连接正常（${r.value.elapsedMs} ms）· 数据文件夹${r.value.folder?.dataFolderExists ? '已存在' : '尚未创建'}`,
            };
          }
          return { ok: false, text: r.text };
        },
        [call, refresh],
      );

      // 远端被别的机器占着时，所有写操作按钮置灰（清单仍可浏览，不持锁）
      const remoteBusy = Boolean(lock && !lock.isMine && !lock.free);

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.header },
          h(SyncShuttleIcon),
          h('h1', { style: S.h1 }, '穿梭 · 同步中转'),
          h('span', { style: S.note }, '两台电脑不同时开机也能同步文件'),
        ),
        h(StatusBar, { status, lock, onRefresh: refresh, busy }),
        h(
          'div',
          { style: S.tabs },
          h('button', { style: tab === 'projects' ? S.tabActive : S.tab, onClick: () => setTab('projects') }, '项目'),
          h('button', { style: tab === 'upload' ? S.tabActive : S.tab, onClick: () => setTab('upload') }, '上传'),
          h('button', { style: tab === 'download' ? S.tabActive : S.tab, onClick: () => setTab('download') }, '下载'),
          h('button', { style: tab === 'settings' ? S.tabActive : S.tab, onClick: () => setTab('settings') }, '设置'),
        ),
        tab === 'projects'
          ? h(ProjectsTab, {
              list,
              onUpload,
              onDownload,
              onBind,
              onCreate,
              onDelete,
              onKeepPrev,
              onCleanResidue,
              currentJob: job && job.status === 'running' ? job : null,
              remoteBusy,
            })
          : null,
        tab === 'upload'
          ? h(UploadTab, {
              list,
              onUpload,
              job,
              onDismissJob: () => setJob(null),
              onResolveJob,
              remoteBusy,
            })
          : null,
        tab === 'download'
          ? h(DownloadTab, {
              list,
              onDownload,
              job,
              onDismissJob: () => setJob(null),
              onResolveJob,
              remoteBusy,
            })
          : null,
        tab === 'settings' ? h(SettingsTab, { settings, onSave: onSaveCreds, onTest, status }) : null,
        // 任务面板在「上传/下载」分区内就地展示，避免同一任务出现两份
        tab === 'upload' || tab === 'download'
          ? null
          : h(JobPanel, { job, onDismiss: () => setJob(null), onResolve: onResolveJob }),
      );
    }

    const inject = ['slots', 'connection'];

    function apply(ctx) {
      const rpc = (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);
      const disposers = [];

      disposers.push(
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 61, label: '穿梭 · 同步中转' },
            SyncShuttleIcon,
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ rpc }) }, SyncShuttlePage),
        ),
      );

      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* ignore */
          }
        }
      };
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
