const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack = require('webpack');
const { createRevisionMiddleware } = require('./dev/revision-proxy.cjs');
const isDevelopment = process.env.NODE_ENV === 'development';
const isLocalPreview = process.env.LOCAL_PREVIEW === '1';
const configPath = path.resolve(__dirname, 'app.json');
let appConfig = {};
if (!isLocalPreview) {
  // The official plugin reads this same ignored JSON file for build/debug config.
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing app.json. Copy app.example.json to app.json and fill in your Feishu appID and blockTypeID.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  appConfig = config;
  for (const key of ['appID', 'blockTypeID']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error(`Missing ${key} in local app.json. Fill in the value from the Feishu developer console.`);
    }
  }
}
const addonUtils = isLocalPreview
  ? null
  : require('@lark-opdev/block-docs-addon-webpack-utils');

module.exports = {
  entry: './src/index.js',
  devtool: isDevelopment ? 'source-map' : false,
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    clean: true,
    publicPath: isDevelopment ? '/block/' : './',
  },
  module: {
    rules: [{
      test: /\.css$/,
      use: [
        isDevelopment ? 'style-loader' : MiniCssExtractPlugin.loader,
        'css-loader',
      ],
    }],
  },
  plugins: [
    new webpack.DefinePlugin({
      LOCAL_PREVIEW: JSON.stringify(isLocalPreview),
      REVISION_API_URL: JSON.stringify(isDevelopment && !isLocalPreview
        ? 'http://localhost:5173/__heatmap/revision' : appConfig.revisionApiUrl || ''),
    }),
    ...(!isDevelopment ? [new MiniCssExtractPlugin({ filename: 'index.css' })] : []),
    ...(!isLocalPreview ? [new addonUtils.docsAddonWebpackPlugin()] : []),
    new HtmlWebpackPlugin({ template: './src/index.html' }),
  ],
  devServer: isDevelopment ? {
    host: isLocalPreview ? '127.0.0.1' : 'localhost',
    port: 5173,
    headers: { 'Access-Control-Allow-Private-Network': 'true' },
    hot: true,
    client: { logging: 'error' },
    setupMiddlewares: (middlewares, devServer) => {
      if (!isLocalPreview) {
        devServer.app.use('/__heatmap/revision', createRevisionMiddleware(configPath));
        // Official middleware opens the Feishu document debugging page.
        addonUtils.docsAddonDevMiddleware(devServer).then((middleware) => {
          devServer.app.use(middleware);
        }).catch((error) => {
          console.error('Feishu debug initialization failed:', error.message);
          devServer.stopCallback(() => { process.exitCode = 1; });
        });
      }
      return middlewares;
    },
  } : undefined,
};
