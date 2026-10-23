// Editorial metadata and bundled media only. Installation and access remain host-owned.
(() => {
  const catalog = Object.assign(Object.create(null), {
    // xingtu-store:start
    "centaurai.wanx.semantica": {
      "key": "xingtu",
      "name": "星图",
      "category": "知识与数据",
      "tagline": "让知识相连，让应用有据。",
      "introduction": "星图是你的本地知识数据仓。按项目或主题建仓，导入资料，由本机或盒子的本地模型整理为可追溯的知识图谱。你可以检索证据，也可以按仓授权，让其他应用用上这些知识。",
      "features": [
        [
          "用图谱看见联系",
          "从资料中提取实体、关系与来源，沿着每一条连线回到材料核对。"
        ],
        [
          "在本地整理，随仓迁移",
          "保留原始资料与正文版本，以迁移包带走完整知识仓；清空前需再次确认。"
        ],
        [
          "把知识交给你的应用",
          "创建单仓只读凭证，开放检索、图谱和证据接口，可设置有效期并随时撤销。"
        ]
      ],
      "posters": [
        [
          "xingtu-product-v1.png",
          "让知识相连，让发现有据。",
          "产品概念海报"
        ]
      ]
    },
    // xingtu-store:end
    'centaurai.wanx.zhijun': {
      key: 'zhijun', name: '知君', category: '生活与记忆', tagline: '有处可说，有迹可循。',
      introduction: '从一段轻松的对话开始，把念头、经历与值得收藏的资料留在自己的空间。知君陪你回看，也让你随时修正它对你的理解。',
      features: [['聊聊此刻的你', '不必组织好语言，从日常想法到重要决定，都可以慢慢说。'], ['留下可以修正的理解', '对话、记忆与个人角色相互衔接，始终由你定义自己。'], ['收藏值得回看的线索', '在知识库整理参考资料，让下一次对话有迹可循。']],
      posters: [['zhijun-product-v1.png', '有处可说，有迹可循。', '产品概念海报']],
    },
    'centaurai.wanx.superadvisors': {
      key: 'council', name: '个人议事厅', category: '思考与决策', tagline: '一起商量，由你决定。',
      introduction: '工作上的选择，生活里的打算。先与会议秘书聊清背景，再请参谋一起商量。把不同意见留在一处，把最终决定留给自己。',
      features: [['先把事情讲清楚', '会议秘书帮助整理背景、目标与条件，再进入讨论。'], ['让不同意见一起上桌', '选择参谋，从不同角度打磨方案，也可以调整讨论方向。'], ['留下报告，随时续议', '回看议事过程与报告，围绕同一件事继续商量。']],
      posters: [['council-product-v1.png', '一起商量，由你决定。', '产品概念海报']],
    },
    'centaurai.wanx.dialogue': {
      key: 'dialogue', name: '众见', category: '探索与学习', tagline: '一个问题，多种智能视角。',
      introduction: '让不同模型各自思考，比较它们的回答，再沿着有价值的方向继续聊。适合探索想法、分析问题，也适合把复杂的知识讲清楚。',
      features: [['同一个问题，分别回答', '一次选择最多三个视角，保留各自完整的思考。'], ['沿着好答案深入', '从某一条回答开启独立续聊，不把其他回答混入上下文。'], ['保留自己的判断', '查看差异和依据；多个回答达成共识，也不等于事实已经验证。']],
      posters: [['dialogue-product-v1.png', '一个问题，多种智能视角。', '产品概念海报']],
    },
    'centaurai.wanx.centaurloop': {
      key: 'loop', name: '半人马环', category: '效率与自动化', tagline: '人在环中，AI 持续行动。',
      introduction: '把重复的小事交给 AI，把关键判断留给你。确认目标与规则后，半人马环按安排执行；遇到问题时停下来问你，再把你的决定带入下一轮。',
      features: [['说清一件重复的小事', '从每日资料摘要、变化检查或每周汇总开始，逐步搭建任务。'], ['过程与成果看得见', '在我的环查看运行情况、最近成果和接下来的安排。'], ['关键时刻等你判断', '需要判断的事情集中呈现，让反馈成为下一次行动的依据。']],
      posters: [['loop-product-v1.png', '人在环中，AI 持续行动。', '产品概念海报']],
    },
    'centaurai.wanx.ai-browser': {
      key: 'browser', name: '万象 AI 浏览器', category: '浏览与协作', tagline: '这一页，和 AI 一起完成。',
      introduction: '在万象服务器上浏览网页，亲自操作，或与 AI 专家协作。网页是主要工作区，助手随时在旁边；需要时，你可以接回控制。',
      features: [['网页始终是主角', '在独立浏览工作区访问和操作网页，按需展开 AI 助手。'], ['把意图告诉专家', '围绕当前网页总结、查找信息，或协作完成页面上的操作。'], ['随时接管，积累方法', '在人工操作与 AI 协作之间切换，也可以记录和复用操作技能。']],
      posters: [['browser-product-v1.png', '这一页，和 AI 一起完成。', '产品概念海报']],
    },
    'centaurai.media-express': {
      key: 'publisher', name: '视频号助手', category: '创作与发布', tagline: '从一段视频，到一次从容的发布。',
      introduction: '把素材交给内容发布专家，用对话说明发布目标与时间。结合视频理解、文案准备、账号管理与发布预览，让每一步都有据可查。',
      features: [['围绕素材准备内容', '添加视频或批量导入目录，结合画面理解准备发布文案。'], ['管理视频号与发布时间', '扫码连接账号，检查状态，按需准备定时发布。'], ['预览后再确认', '核对文案、素材和原创声明；在任务中分别查看投稿、审核与公开发布状态。']],
      posters: [['publisher-product-v1.png', '从一段视频，到从容发布。', '产品概念海报']],
    },
  });
  for (const value of Object.values(catalog)) {
    value.icon = `assets/app-icons/${value.key}-v1.png`;
    value.features = Object.freeze(value.features.map(Object.freeze));
    value.posters = Object.freeze(value.posters.map(Object.freeze));
    Object.freeze(value);
  }
  window.wanxAppCatalog = Object.freeze(catalog);
})();
