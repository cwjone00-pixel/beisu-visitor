/* ============================================================
   海南全岛地图 · 点位数据
   ------------------------------------------------------------
   由地图页（index.html）的「选类型 + 点地图」录入后自动回写本文件；
   也可手工编辑（保持 window.MAP_CATEGORIES / window.MAP_POINTS 两个全局变量即可）。
   ------------------------------------------------------------
   分类字段：key 唯一标识 | name 名称 | color 颜色 | symbol 图标
             symbolSize 单标记大小 | showLabel 是否常显标签 | z 层级
   点位字段：id 唯一标识 | categories 所属分类 key 数组（每次落点记录一个类型）
             lng/lat 经纬度 | name 地名/位置名称（可空，由使用者在页面上手动填写）
             names 地名三语 { zh, en, ru } | intro 介绍三语 { zh, en, ru }
             （name 始终与 names.zh 保持一致，老前台逻辑只认 name，故一并保留）
   说明：同一位置可录入多条记录（不同类型各成一条），前端按坐标聚合成多层同心圆环显示。
   ============================================================ */

window.MAP_CATEGORIES = [
  {
    "key": "play",
    "name": "游玩打卡",
    "color": "#d2cc1e",
    "symbol": "circle",
    "symbolSize": 14,
    "showLabel": true,
    "z": 20
  }
];

window.MAP_POINTS = [
  {
    "id": "p_mv9fwwxh2dzy",
    "categories": [
      "play"
    ],
    "lng": 110.344604,
    "lat": 20.039708,
    "name": "骑楼老街",
    "names": {
      "zh": "骑楼老街"
    }
  },
  {
    "id": "p_mv9fxqtz7kko",
    "categories": [
      "play"
    ],
    "lng": 110.864306,
    "lat": 19.530677,
    "name": "东郊椰林",
    "names": {
      "zh": "东郊椰林"
    }
  },
  {
    "id": "p_mv9fyfv4gjbu",
    "categories": [
      "play"
    ],
    "lng": 110.560897,
    "lat": 19.133168,
    "name": "博鳌亚洲论坛永久会址",
    "names": {
      "zh": "博鳌亚洲论坛永久会址"
    }
  },
  {
    "id": "p_mv9fz2fxvdtg",
    "categories": [
      "play"
    ],
    "lng": 110.215086,
    "lat": 18.626002,
    "name": "日月湾",
    "names": {
      "zh": "日月湾"
    }
  },
  {
    "id": "p_mv9fzsjkur9o",
    "categories": [
      "play"
    ],
    "lng": 110.201546,
    "lat": 18.576845,
    "name": "分界洲岛",
    "names": {
      "zh": "分界洲岛"
    }
  },
  {
    "id": "p_mv9g0jzpwvb5",
    "categories": [
      "play"
    ],
    "lng": 109.643059,
    "lat": 18.253643,
    "name": "亚龙湾热带天堂森林公园",
    "names": {
      "zh": "亚龙湾热带天堂森林公园"
    }
  },
  {
    "id": "p_mv9g72rx6t12",
    "categories": [
      "play"
    ],
    "lng": 108.907698,
    "lat": 18.721715,
    "name": "尖峰岭国家森林公园",
    "names": {
      "zh": "尖峰岭国家森林公园"
    }
  },
  {
    "id": "p_mv9gecgb310a",
    "categories": [
      "play"
    ],
    "lng": 110.365616,
    "lat": 19.552673,
    "name": "文笔峰",
    "names": {
      "zh": "文笔峰"
    }
  },
  {
    "id": "p_mv9gev5gqbj5",
    "categories": [
      "play"
    ],
    "lng": 109.829192,
    "lat": 19.004169,
    "name": "白花岭",
    "names": {
      "zh": "白花岭"
    }
  },
  {
    "id": "p_mv9gfihhbfk3",
    "categories": [
      "play"
    ],
    "lng": 109.504727,
    "lat": 19.205755,
    "name": "陨石坑",
    "names": {
      "zh": "陨石坑"
    }
  },
  {
    "id": "p_mv9gg3vgqu48",
    "categories": [
      "play"
    ],
    "lng": 109.083759,
    "lat": 18.995131,
    "name": "俄贤岭",
    "names": {
      "zh": "俄贤岭"
    }
  },
  {
    "id": "p_mv9ggplgdini",
    "categories": [
      "play"
    ],
    "lng": 109.917566,
    "lat": 19.867697,
    "name": "福山咖啡文化风情镇",
    "names": {
      "zh": "福山咖啡文化风情镇"
    }
  },
  {
    "id": "p_mv9ghda0pmll",
    "categories": [
      "play"
    ],
    "lng": 109.170718,
    "lat": 19.660878,
    "name": "海花岛",
    "names": {
      "zh": "海花岛"
    }
  },
  {
    "id": "p_mv9ghv21e0ko",
    "categories": [
      "play"
    ],
    "lng": 109.647174,
    "lat": 18.459218,
    "name": "呀诺达雨林文化旅游区",
    "names": {
      "zh": "呀诺达雨林文化旅游区"
    }
  },
  {
    "id": "p_mv9giqkqltua",
    "categories": [
      "play"
    ],
    "lng": 108.69688,
    "lat": 19.368177,
    "name": "棋子湾",
    "names": {
      "zh": "棋子湾"
    }
  },
  {
    "id": "p_mv9gjdiikx8h",
    "categories": [
      "play"
    ],
    "lng": 109.678087,
    "lat": 18.842413,
    "name": "五指山热带雨林风景区",
    "names": {
      "zh": "五指山热带雨林风景区"
    }
  }
];
