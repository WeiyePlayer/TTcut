const releaseUrl = "https://github.com/WeiyePlayer/TTcut/releases/tag/v1.0.0";
const repositoryUrl = "https://github.com/WeiyePlayer/TTcut";

const features = [
  {
    number: "01",
    title: "自动识别回合",
    description: "完成球桌标定后，TTcut 会定位乒乓球、识别弹跳，并把连续事件整理为可剪辑的有效回合。",
  },
  {
    number: "02",
    title: "三种剪辑模式",
    description: "保留全部回合、按板数筛选精彩回合，或逐个选择需要的片段。",
  },
  {
    number: "03",
    title: "先预览，再决定",
    description: "自定义模式可直接预览单个回合，预览会在回合前后各保留 1 秒。",
  },
  {
    number: "04",
    title: "历史分析复用",
    description: "再次打开同一个视频时，可复用已经完成的分析，直接回到剪辑模式选择。",
  },
  {
    number: "05",
    title: "保留完整上下文",
    description: "在设置中选择回合前后保留时间，避免成片在发球或回合结束处显得仓促。",
  },
  {
    number: "06",
    title: "安全导出",
    description: "成片保存到原视频目录，遇到同名文件会自动编号，始终不覆盖已有视频。",
  },
];

const steps = [
  {
    label: "选择视频",
    copy: "选择一个 MP4 文件。TTcut 会先检查视频是否可读取，并显示时长、画面尺寸与帧率。",
  },
  {
    label: "标定球桌",
    copy: "依次点击球桌的左上、右上、右下、左下四个角。标记可拖动调整，确认后再开始分析。",
  },
  {
    label: "挑选回合",
    copy: "分析完成后，选择全部、精彩或自定义模式。需要时先预览单个回合，再确定保留内容。",
  },
  {
    label: "导出成片",
    copy: "开始剪辑后等待进度完成，即可播放成片、定位文件，或继续处理下一个视频。",
  },
];

const faqs = [
  {
    question: "TTcut 支持什么视频？",
    answer: "当前一次处理一个 MP4 视频。拖入多个文件或其他格式时，软件会提示重新选择。",
  },
  {
    question: "“板数”是真实击球次数吗？",
    answer: "不是。当前版本以识别到的弹跳次数作为板数代理值，适合筛选较长回合，但不代表球拍实际击球次数。",
  },
  {
    question: "使用时必须联网吗？",
    answer: "首次安装分析组件和视频处理组件时需要联网。设置完成后，分析、预览和剪辑都可以离线完成。",
  },
  {
    question: "导出文件保存在哪里？",
    answer: "保存在原视频所在目录。例如 match.mp4 会导出为 match_ttcut.mp4；同名文件已存在时会自动添加编号。",
  },
  {
    question: "Windows 为什么提示未知发布者？",
    answer: "v1.0.0 预发布安装包尚未进行 Authenticode 签名，因此可能触发 SmartScreen。请只从本项目的 GitHub Release 页面下载。",
  },
];

function ArrowIcon() {
  return <span aria-hidden="true" className="arrow">↗</span>;
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="TTcut 首页">TTcut</a>
        <nav className="nav-links" aria-label="主导航">
          <a href="#features">功能</a>
          <a href="#how-it-works">使用方法</a>
          <a href="#modes">剪辑模式</a>
          <a href="#faq">常见问题</a>
        </nav>
        <a className="button button-small" href={releaseUrl} target="_blank" rel="noreferrer">
          下载 <span className="desktop-only">v1.0.0</span><ArrowIcon />
        </a>
      </header>

      <section className="hero section-shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Windows 10 / 11 · 本地离线处理</p>
          <h1>识别每个回合，<br />剪出一场好球。</h1>
          <p className="hero-intro">
            TTcut 为乒乓球视频自动定位有效回合。完成一次球桌标定，即可选择想保留的内容并导出成片。
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={releaseUrl} target="_blank" rel="noreferrer">
              下载 TTcut <ArrowIcon />
            </a>
            <a className="button button-secondary" href="#how-it-works">查看使用方法 <span aria-hidden="true">↓</span></a>
          </div>
          <ul className="trust-list" aria-label="隐私特点">
            <li><span aria-hidden="true">✓</span> 无需登录</li>
            <li><span aria-hidden="true">✓</span> 不上传视频</li>
            <li><span aria-hidden="true">✓</span> 设置后可离线</li>
          </ul>
        </div>

        <div className="product-frame" aria-label="TTcut 回合分析界面示意图">
          <div className="window-bar">
            <span className="window-brand">TTcut</span>
            <span className="window-stage">3 / 4&nbsp;&nbsp;选择剪辑模式</span>
            <div className="window-controls" aria-hidden="true"><i></i><i></i><i></i></div>
          </div>
          <div className="app-preview">
            <aside className="preview-sidebar">
              <b>TTcut</b>
              <span className="side-active">自动剪辑</span>
              <span>历史剪辑</span>
              <span className="side-bottom">设置</span>
            </aside>
            <div className="preview-main">
              <div className="preview-title-row">
                <div><small>已识别</small><strong>47 个有效回合</strong></div>
                <span className="status-pill">分析完成</span>
              </div>
              <div className="mode-strip">
                <div className="mini-mode selected"><span></span><b>所有回合</b><small>47 / 47</small></div>
                <div className="mini-mode"><span></span><b>精彩回合</b><small>按板数筛选</small></div>
                <div className="mini-mode"><span></span><b>自定义</b><small>逐个选择</small></div>
              </div>
              <div className="rally-card">
                <div className="court" aria-hidden="true">
                  <i className="court-net"></i><i className="court-line"></i>
                  <i className="ball ball-one"></i><i className="ball ball-two"></i><i className="ball ball-three"></i>
                  <i className="trail trail-one"></i><i className="trail trail-two"></i>
                </div>
                <div className="rally-data">
                  <span>回合 03</span><b>8 板</b><small>00:36.200 — 00:43.840</small>
                  <div className="fake-button">预览回合</div>
                </div>
              </div>
              <div className="preview-footer"><span>回合前 2.5 秒 · 回合后 2 秒</span><b>开始剪辑</b></div>
            </div>
          </div>
        </div>
      </section>

      <section className="privacy-band" aria-label="隐私说明">
        <p>视频留在你的电脑里。</p>
        <span>不登录、不上传、不采集遥测。首次组件设置完成后，整个工作流程都可离线运行。</span>
      </section>

      <section className="section-shell content-section" id="features">
        <div className="section-heading">
          <p className="eyebrow">专注一件事</p>
          <h2>从一场长视频，<br />到值得保留的每个回合。</h2>
          <p>分析、选择、预览和导出集中在一个清晰流程中。</p>
        </div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <span>{feature.number}</span>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="content-section how-section" id="how-it-works">
        <div className="section-shell">
          <div className="section-heading compact">
            <p className="eyebrow">四步完成</p>
            <h2>第一次使用，也很自然。</h2>
          </div>
          <ol className="steps-list">
            {steps.map((step, index) => (
              <li key={step.label}>
                <div className="step-number">{String(index + 1).padStart(2, "0")}</div>
                <div><h3>{step.label}</h3><p>{step.copy}</p></div>
              </li>
            ))}
          </ol>
          <div className="calibration-demo">
            <div className="calibration-copy">
              <span>球桌标定</span>
              <h3>四个角，决定识别区域。</h3>
              <p>按照屏幕顺序点击桌面四角。编号、连线与即时校验会帮助你确认位置；任何标记都能直接拖动修正。</p>
              <div className="point-order"><i>1</i><b>左上</b><i>2</i><b>右上</b><i>3</i><b>右下</b><i>4</i><b>左下</b></div>
            </div>
            <div className="calibration-stage" aria-label="四点标定示意图">
              <div className="table-shape"></div>
              <span className="pin pin-one">1</span><span className="pin pin-two">2</span>
              <span className="pin pin-three">3</span><span className="pin pin-four">4</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section-shell content-section" id="modes">
        <div className="section-heading split-heading">
          <div><p className="eyebrow">按你的方式保留</p><h2>三种模式，<br />一个清楚的选择。</h2></div>
          <p>分析结果不会替你做最终决定。你可以保留全部内容，也可以用筛选和预览快速缩小范围。</p>
        </div>
        <div className="mode-grid">
          <article className="mode-card mode-primary">
            <div className="mode-top"><span>A</span><small>完整</small></div>
            <h3>所有回合</h3><p>剪辑视频中识别到的全部有效回合，适合保存完整比赛内容。</p>
            <div className="mode-sample"><b>47</b><span>个回合全部选中</span></div>
          </article>
          <article className="mode-card">
            <div className="mode-top"><span>H</span><small>快速</small></div>
            <h3>精彩回合</h3><p>选择 3、5 或 7 板，只保留<strong>严格大于</strong>该板数的回合。</p>
            <div className="thresholds"><i>3</i><i className="active">5</i><i>7</i><span>板以上</span></div>
          </article>
          <article className="mode-card">
            <div className="mode-top"><span>C</span><small>精确</small></div>
            <h3>自定义</h3><p>逐个勾选想保留的回合，并在决定前播放预览。</p>
            <div className="selection-lines"><i></i><i className="checked"></i><i></i><i className="checked"></i></div>
          </article>
        </div>
        <p className="proxy-note"><span>说明</span> 当前版本的“板数”使用识别到的弹跳次数作为代理值，并非球拍实际击球次数。</p>
      </section>

      <section className="timing-section content-section">
        <div className="section-shell timing-layout">
          <div className="section-heading compact">
            <p className="eyebrow">不让精彩戛然而止</p>
            <h2>回合前后，<br />都留一点呼吸。</h2>
            <p>导出采用设置中的回合前、回合后时间；回合预览则固定前后各 1 秒。</p>
          </div>
          <div className="timeline-card">
            <div className="timeline-labels"><span>回合前</span><b>有效回合</b><span>回合后</span><i>收尾 +1 秒</i></div>
            <div className="timeline-bar"><span></span><b></b><span></span><i></i></div>
            <div className="timeline-details">
              <div><small>导出</small><strong>采用设置中的时间</strong></div>
              <div><small>预览</small><strong>前后固定各 1 秒</strong></div>
              <div><small>剪辑组结尾</small><strong>最后一回合额外 +1 秒</strong></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-shell content-section history-section">
        <div className="history-visual" aria-label="历史剪辑列表示意图">
          <div className="history-card history-back"><div></div><span></span><i></i></div>
          <div className="history-card history-front">
            <div className="history-cover"><span className="play-dot">▶</span></div>
            <div className="history-copy"><b>1-193.mp4</b><span>47 个回合</span><small>00:08:27.440</small></div>
          </div>
        </div>
        <div className="section-heading compact history-text">
          <p className="eyebrow">历史剪辑</p>
          <h2>分析一次，<br />下次直接开始选择。</h2>
          <p>TTcut 会记录同一视频的分析数据。历史列表展示首帧封面、视频名称、回合数与视频长度，点击即可返回剪辑模式页面。</p>
        </div>
      </section>

      <section className="section-shell content-section faq-section" id="faq">
        <div className="section-heading compact"><p className="eyebrow">常见问题</p><h2>开始前，你可能想知道。</h2></div>
        <div className="faq-list">
          {faqs.map((faq) => (
            <details key={faq.question}>
              <summary>{faq.question}<span aria-hidden="true">＋</span></summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="final-cta section-shell">
        <p className="eyebrow">TTcut v1.0.0 Pre-release</p>
        <h2>下一场好球，<br />从这里开始。</h2>
        <p>下载 Windows x64 版本，让比赛视频留在本地，让精彩回合更容易被看见。</p>
        <a className="button button-light" href={releaseUrl} target="_blank" rel="noreferrer">前往 GitHub 下载 <ArrowIcon /></a>
      </section>

      <footer className="site-footer section-shell">
        <a className="brand" href="#top">TTcut</a>
        <p>本地离线乒乓球回合分析与自动剪辑工具。</p>
        <div><a href={repositoryUrl} target="_blank" rel="noreferrer">GitHub</a><a href={releaseUrl} target="_blank" rel="noreferrer">下载</a><a href={`${repositoryUrl}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License</a></div>
      </footer>
    </main>
  );
}
