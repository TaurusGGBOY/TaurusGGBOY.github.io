---
title: "造轮子第一步：自己搭建博客"
published: 2019-05-02
description: "Notes from rebuilding a personal blog from the ground up, including theme choices, static publishing, and the tradeoffs of owning the site."
tags: ["blog", "hexo", "frontend"]
category: "Web"
draft: false
---

既然想要拿到五年之后的ssp的话，总的有一些自己造轮子的东西。`

那么就从第一步简单的自己开始

# 博客的搭建

## hexo初始化

1. 安装git
2. 安装nodejs
3. 新建文件夹blog
4. 在blog下运行命令`npm -install -g hexo-cli`
5. 运行`hexo init myblog`
6. `cd myblog`
7. `npm install`
8. `hexo g`
9. `hexo server`
10. 进入`http://localhost:4000`就可以看到你的网站了

## hexo部署到Github

1. 打开github，创建`xxxx.github.io`项目，其中`xxxx`是你的用户名
2. 打开`myblog`中的`_config.yml`
3. 将最后修改为

```yml
deploy:
  type: git
  repo: https://github.com/xxxx/xxxx.github.io.git
  branch: master
```

​ 其中`xxxx`是你的github用户名

1. 除此之外，还要改一下语言
  `language: zh-CN`
2. 运行`npm install hexo-deployer-git --save`
3. 运行`hexo clean
  hexo generate
  hexo deploy`
  途中要登录自己的github账号
4. 访问`http://xxxx.github.io`可以看到自己的账号了

## hexo部署到codingPage

1. 注册codingPage
2. 在codingPage中添加项目，也可以取名为`xxxx`
3. 将密钥添加到codingPage
4. 运行`ssh -T git@git.coding.net`
5. 打开`myblog`中的`_config.yml`
6. 将最后修改为

```yml
deploy:
  type: git
  repo:
    coding: git@git.dev.tencent.com:xxxx/xxxx.git,master
    github: git@github.com:xxxx/xxxx.github.io.git,master
```

​ 其中`xxxx`是你的codingPage用户名

1. `hexo g
  hexo d`
2. 代码-Pages服务-一键部署-访问
3. 设置-部署
4. 可尝试访问

## 更改主题

1. 我自己很喜欢Next这个Blog所以推荐这个
  `https://github.com/theme-next/hexo-theme-next/releases`
2. 下载最新版本的zip包
3. 解压到`/myblog/themes`
4. 打开`myblog`中的`_config.yml`
5. 将后面的主题修改为`theme: next`
6. 需要注意的是，themes文件夹里面的主题文件夹也要叫做next
7. `hexo clean`
8. `hexo g`
9. `hexo d`

## 第一篇文章

1. `hexo new post 标题`
2. 修改在post文件夹下的md文件
3. `hexo g`
4. `hexo d`
5. 就可以看到文章了

## 首页显示查看原文按钮

1. 在文章中只要写成如下格式即可：
  `这是摘要`
  `<!-- more -->`
  `这是全文`
2. 需要注意的是，点击 阅读全文 之后，文章会自动定位到 所在位置，想要修改成从头阅读需要修改 主题配置文件 _config.yml 文件：
  `scroll_to_more: false`
