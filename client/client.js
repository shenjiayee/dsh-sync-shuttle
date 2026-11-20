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
      logsRead: 'logs.read',
    };

    const S = {
      page: {
        padding: '20px 24px',
        maxWidth: '1080px',
        margin: '0 auto',
        color: 'var(--dsw-alias-label-primary, #1f2329)',
        fontFamily: 'inherit',
        // 三个分区共用同一个页面容器宽度：无论哪个 TAB 的内容多长，
        // 都不允许把容器撑宽。配合 S.card 的 maxWidth:100% 一起生效。
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        overflowX: 'hidden',
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
        // 卡片宽度一律由外层容器决定，绝不被内部长内容撑宽。
        // 否则日志页的 <pre> 长行会把整页撑得比其它页宽 —— 之前正是这个问题。
        boxSizing: 'border-box',
        maxWidth: '100%',
        minWidth: 0,
        overflowWrap: 'anywhere',
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
        // pre-wrap 只按空白折行；日志里的长哈希串/URL 没有空格，
        // 会把容器硬撑宽 —— 这正是「日志页比别的页宽」的原因。
        // 改用 pre-wrap + overflowWrap:anywhere：既保留换行，又能强制断词。
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        // 不让内容决定宽度：宽度交给父容器，超长内容在框内滚动/折行
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: 0,
      },
      // 分区切换按钮：宽度由**父容器**的 Grid 列定义决定，而不是靠按钮自己的 width。
      //
      // 为什么不用 flex + width：宿主主题或全局 button 样式可能带 flex:1 /
      // min-width:auto / 或更高的选择器优先级，把按钮上的 width 顶掉，
      // 于是每个按钮按各自内容分配宽度 —— 激活态文字加粗后就肉眼可见地变宽。
      //
      // Grid 的 gridTemplateColumns 定义在父容器上，列宽由容器决定，
      // 子元素无论自身样式怎么写都无法改变列宽（只能溢出被裁剪）。
      // 三条固定 76px 列 + gap，从布局层面保证等宽。
      // ── 分区切换按钮：三个 TAB 平分整行宽度 ────────────────────────
      //
      // 实现：容器 display:flex，每个 TAB 外层包裹层 flex:1 1 0 + minWidth:0。
      //   · flex-grow:1   → 三个平均分配剩余空间
      //   · flex-basis:0  → 不受内容宽度影响（关键：否则文字长的会更宽）
      //   · minWidth:0    → 允许收缩到低于内容宽度，配合 basis:0 才真正等分
      // 按钮再 width:100% 填满包裹层。
      // 于是三个 TAB 恒等宽，且随窗口宽度自适应。
      tabs: {
        display: 'flex',
        flexWrap: 'nowrap',
        gap: '6px',
        marginBottom: '14px',
        alignItems: 'stretch',
        width: '100%',
      },
      // 包裹层：三等分之一。basis:0 是等分的关键，不能用 auto
      tabWrap: {
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
      },
      // 按钮：填满包裹层，自身不参与宽度计算
      tab: {
        flex: '1 1 auto',
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        padding: '6px 0',
        margin: 0,
        borderRadius: '6px',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        // 未激活也给可见边界，保证三个"方块"一样大、都看得见
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
        color: 'var(--dsw-alias-label-secondary, #4e5969)',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontWeight: 500,
      },
      tabActive: {
        flex: '1 1 auto',
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        padding: '6px 0',
        margin: 0,
        borderRadius: '6px',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        // 与 tab 完全相同的盒模型，只在颜色上区分选中
        border: '1px solid var(--dsw-alias-brand-primary, #165dff)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-brand-primary, #165dff)',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontWeight: 500,
      },
      // 两个字重故意相同：靠边框颜色 + 背景 + 文字色区分选中，
      // 不用加粗，避免粗体造成的"视觉更宽"
      tabText: { fontWeight: 500 },
      tabActiveText: { fontWeight: 500 },
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

    function ProjectsTab({
      list,
      onUpload,
      onDownload,
      onBind,
      onCreate,
      onDelete,
      onKeepPrev,
      onCleanResidue,
      currentJob,
      remoteBusy,
      job,
      onDismissJob,
      onResolveJob,
    }) {
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

        // ── 当前任务面板（上传/下载进度、口令/确认、结果报告）
        // 上传下载已并入项目清单，任务面板放在清单上方常驻展示
        job ? h('div', { style: { marginBottom: '14px' } }, h(JobPanel, { job, onDismiss: onDismissJob, onResolve: onResolveJob })) : null,
        job && job.status === 'done' && job.result
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, job.kind === 'upload' ? '上传完成' : '下载完成'),
              job.kind === 'download'
                ? h('div', { style: { fontSize: '13px' } }, `目标目录：${job.result.targetDir}`)
                : h(
                    'div',
                    { style: { fontSize: '13px' } },
                    `${job.result.volumes} 卷 · ${fmtBytes(job.result.archiveBytes)} · 回读校验通过`,
                  ),
              job.kind === 'download'
                ? h(
                    'div',
                    { style: { ...S.note, marginTop: '4px' } },
                    `新建 ${job.result.created} / 覆盖 ${job.result.overwritten} / 未变 ${job.result.unchanged ?? 0} / 删除 ${job.result.deleted} 个文件 · ${fmtBytes(job.result.bytes)}`,
                  )
                : h(
                    'div',
                    { style: { ...S.note, marginTop: '4px' } },
                    job.result.cleanMessage || '',
                  ),
              job.result.backupDir
                ? h('div', { style: { ...S.note, marginTop: '4px' } }, `已备份待删文件到：${job.result.backupDir}`)
                : null,
              job.result.skippedVolumes?.length
                ? h('div', { style: { ...S.note, marginTop: '4px' } }, `复用已下载分卷：${job.result.skippedVolumes.length} 卷`)
                : null,
              job.result.missingAfter?.length
                ? h('div', { style: S.err, marginTop: '4px' }, `解包后仍缺少 ${job.result.missingAfter.length} 个文件：${job.result.missingAfter.slice(0, 10).join('、')}`)
                : null,
              job.result.extraAfter?.length
                ? h('div', { style: S.err, marginTop: '4px' }, `解包后仍多余 ${job.result.extraAfter.length} 个文件：${job.result.extraAfter.slice(0, 10).join('、')}`)
                : null,
            )
          : null,

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
            // 该项目的全部版本（最新在前），用于逐版下载/回滚
            const versions = [p.latest, ...(p.history || [])].filter(Boolean);
            const busyHere = Boolean(currentJob);
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

              // ── 版本列表：可直接对任意版本下载（历史版即回滚）
              versions.length
                ? h(
                    'div',
                    { style: { marginTop: '8px' } },
                    versions.map((v, i) =>
                      h(
                        'div',
                        {
                          key: v.versionId,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            flexWrap: 'wrap',
                            padding: '5px 0',
                            borderTop: i === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
                          },
                        },
                        i === 0 ? h('span', { style: S.chipOk }, '最新') : h('span', { style: S.chip }, '历史'),
                        h('span', { style: { fontSize: '13px' } }, `${fmtTime(v.uploadedAt)} · ${v.sizeText} · ${v.volumes} 卷`),
                        v.status === 'complete'
                          ? null
                          : h('span', { style: S.chipErr }, v.status === 'missing' ? `缺第 ${(v.missing || []).join('、')} 卷` : '字节数不符'),
                        h('span', { style: { flex: 1 } }),
                        h(
                          'button',
                          {
                            style: S.btn,
                            disabled: !p.bound || busyHere || Boolean(remoteBusy) || v.status !== 'complete',
                            title: !p.bound
                              ? '请先绑定本地目录'
                              : remoteBusy
                                ? '远端正被另一台电脑占用'
                                : v.status !== 'complete'
                                  ? '该版本不完整，无法下载'
                                  : i === 0
                                    ? '下载并镜像覆盖本地目录'
                                    : '回滚到该历史版本',
                            onClick: () => onDownload(p.project, v.versionId),
                          },
                          i === 0 ? '下载并镜像' : '回滚到此版',
                        ),
                      ),
                    ),
                  )
                : null,

              p.keepPrev
                ? h('div', { style: { ...S.note, marginTop: '6px' } }, '└ 已开启「保留上一版」：下次上传后保留最近 2 个版本')
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
                        disabled: busyHere || Boolean(remoteBusy),
                        title: remoteBusy ? '远端正被另一台电脑占用，请等它结束或稍后重试' : '',
                      },
                      '上传新版本',
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

    /**
     * 日志分区：查看本机运行日志。
     *
     * 后端 logs.read 已做脱敏（授权码、完整邮箱地址不会出现在日志里，见 lib/log.js），
     * 所以这里直接展示即可。默认看最近 1 天，可切 3/7 天。
     */
    function LogsTab({ onLoad, status }) {
      const [days, setDays] = useState(1);
      const [logs, setLogs] = useState(null);
      const [loading, setLoading] = useState(false);
      const [err, setErr] = useState(null);
      const [autoRefresh, setAutoRefresh] = useState(false);

      const load = useCallback(
        async (d) => {
          setLoading(true);
          setErr(null);
          const r = await onLoad(d);
          setLoading(false);
          if (r.ok) setLogs(r.value?.logs || []);
          else setErr(r.text);
        },
        [onLoad],
      );

      // 首次进入即加载
      useEffect(() => {
        load(days);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 自动刷新（每 5 秒）
      useEffect(() => {
        if (!autoRefresh) return undefined;
        const t = setInterval(() => load(days), 5000);
        return () => clearInterval(t);
      }, [autoRefresh, days, load]);

      const totalLines = (logs || []).reduce((s, d) => s + (d.lines?.length || 0), 0);

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '运行日志'),
          h(
            'div',
            { style: { ...S.row } },
            h('span', { style: S.label }, '时间范围'),
            ...[1, 3, 7].map((d) =>
              h(
                'button',
                {
                  key: d,
                  type: 'button',
                  style: days === d ? S.btnPrimary : S.btn,
                  onClick: () => {
                    setDays(d);
                    load(d);
                  },
                },
                `最近 ${d} 天`,
              ),
            ),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              { type: 'button', style: S.btn, onClick: () => load(days), disabled: loading },
              loading ? '刷新中…' : '刷新',
            ),
            h(
              'button',
              {
                type: 'button',
                style: autoRefresh ? S.btnPrimary : S.btn,
                onClick: () => setAutoRefresh((v) => !v),
              },
              autoRefresh ? '⏸ 停止自动刷新' : '▶ 自动刷新（5s）',
            ),
          ),
          h(
            'div',
            { style: { ...S.note, marginTop: '6px' } },
            status?.dataDir
              ? `日志目录：${status.dataDir}\\logs · 保留 14 天，单文件上限 50 MB`
              : '保留 14 天，单文件上限 50 MB',
          ),
          h(
            'div',
            { style: { ...S.note, marginTop: '2px' } },
            'ⓘ 日志已脱敏：不会记录授权码、完整邮箱地址与加密口令。',
          ),
          err ? h('div', { style: { ...S.err, marginTop: '8px' } }, err) : null,
        ),

        logs
          ? logs.length === 0
            ? h('div', { style: S.card }, h('div', { style: S.note }, '还没有日志'))
            : logs.map((d) =>
                h(
                  'div',
                  { key: d.date, style: S.card },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
                    h('h2', { style: { ...S.h2, margin: 0 } }, d.date),
                    h('span', { style: S.chip }, `${d.lines?.length || 0} 行`),
                    h('span', { style: { flex: 1 } }),
                    d.lines?.length
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: S.btn,
                            onClick: () => {
                              // 复制当天日志到剪贴板，便于贴给别人排查
                              try {
                                navigator.clipboard.writeText(d.lines.join('\n'));
                              } catch {
                                /* 剪贴板不可用时忽略 */
                              }
                            },
                          },
                          '复制',
                        )
                      : null,
                  ),
                  d.lines?.length
                    ? h(
                        'pre',
                        { style: { ...S.pre, maxHeight: '420px' } },
                        d.lines.join('\n'),
                      )
                    : h('div', { style: S.note }, '这一天没有日志'),
                ),
              )
          : null,
        totalLines > 0
          ? h('div', { style: { ...S.note, marginTop: '4px' } }, `共 ${totalLines} 行`)
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
      // 只剩「项目」「设置」两个分区：上传/下载已并入项目卡片
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

      /** 日志分区用：拉取最近 N 天日志。返回 { ok, value:{logs} } 或 { ok:false, text }。 */
      const onLoadLogs = useCallback(
        async (days) => {
          const r = await call(EP.logsRead, { days });
          return r.ok ? { ok: true, value: r.value } : { ok: false, text: r.text };
        },
        [call],
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
        // 三个分区：项目（含上传/下载）、日志、设置
        //
        // 每个 TAB 外面套一层固定 76px 的包裹元素（S.tabWrap）。
        // 宽度由**包裹层**决定，按钮只负责填满它 —— 这样宿主给 button
        // 加的任何样式都无法改变横向尺寸，三个 TAB 在几何上必然等宽。
        h(
          'div',
          { style: S.tabs },
          ...([
            ['projects', '项目'],
            ['logs', '日志'],
            ['settings', '设置'],
          ].map(([key, label]) =>
            h(
              'div',
              { key, style: S.tabWrap },
              h(
                'button',
                {
                  type: 'button',
                  style: tab === key ? S.tabActive : S.tab,
                  onClick: () => setTab(key),
                },
                // 字重统一 500：激活态只靠边框色+背景+文字色区分
                h('span', { style: tab === key ? S.tabActiveText : S.tabText }, label),
              ),
            ),
          )),
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
              job,
              onDismissJob: () => setJob(null),
              onResolveJob,
            })
          : null,
        tab === 'logs' ? h(LogsTab, { onLoad: onLoadLogs, status }) : null,
        tab === 'settings' ? h(SettingsTab, { settings, onSave: onSaveCreds, onTest, status }) : null,
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
