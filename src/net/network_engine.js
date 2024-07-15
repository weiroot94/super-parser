import axios from 'axios';
import { SocksProxyAgent } from "socks-proxy-agent";
import logger from '../util/sp_logger.js'
import fs, { write } from 'fs';

const filePath = import.meta.url;

class network_engine {
  static async http_get(url) {
    const client = axios.create({ baseURL: url });
    logger.sp_debug(filePath, "HTTP requesting to %s...", url);

    var response = await client.get();
    return response.data;
  }

  static async socks5_http_get(url, proxyConf) {
    /* initialize proxy configuration */
    let proxy_agent = null;
    if (proxyConf.use_proxy) {
      proxy_agent = new SocksProxyAgent(`socks://${proxyConf.addr}:${proxyConf.port}`);
    }

    const getClient = axios.create({
      baseURL: url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36'
      },
      httpsAgent: proxy_agent,
      httpAgent: proxy_agent
    });

    const response = await getClient.get();

    return response.data;
  }

  static async socks5_http_download(fileUrl, savePath, proxyConf) {
    const writer = fs.createWriteStream(savePath);

    /* initialize proxy configuration */
    let proxy_agent = null;
    if (proxyConf.use_proxy) {
      proxy_agent = new SocksProxyAgent(`socks://${proxyConf.addr}:${proxyConf.port}`);
    }

    const downloadClient = axios.create({
      baseURL: fileUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36'
      },
      responseType: 'stream',
      httpsAgent: proxy_agent,
      httpAgent: proxy_agent,
    });

    const response = await downloadClient.get();
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }
}

export default network_engine;