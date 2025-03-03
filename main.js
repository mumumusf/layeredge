import fs from 'fs/promises';
import axios from "axios";
import chalk from "chalk";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Wallet } from "ethers";
import banner from './utils/banner.js';
import readline from 'readline';

const logger = {
    verbose: true,
    
    _formatTimestamp() {
        return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
    },

    _getLevelStyle(level) {
        const styles = {
            info: chalk.blueBright.bold,
            warn: chalk.yellowBright.bold,
            error: chalk.redBright.bold,
            success: chalk.greenBright.bold,
            debug: chalk.magentaBright.bold,
            verbose: chalk.cyan.bold
        };
        return styles[level] || chalk.white;
    },

    _formatError(error) {
        if (!error) return '';
        
        let errorDetails = '';
        if (axios.isAxiosError(error)) {
            errorDetails = `
            Status: ${error.response?.status || 'N/A'}
            Status Text: ${error.response?.statusText || 'N/A'}
            URL: ${error.config?.url || 'N/A'}
            Method: ${error.config?.method?.toUpperCase() || 'N/A'}
            Response Data: ${JSON.stringify(error.response?.data || {}, null, 2)}
            Headers: ${JSON.stringify(error.config?.headers || {}, null, 2)}`;
        }
        return `${error.message}${errorDetails}`;
    },

    log(level, message, value = '', error = null) {
        const timestamp = this._formatTimestamp();
        const levelStyle = this._getLevelStyle(level);
        const levelTag = levelStyle(`[${level.toUpperCase()}]`);
        const header = chalk.cyan('◆ LayerEdge Auto Bot');

        let formattedMessage = `${header} ${timestamp} ${levelTag} ${message}`;
        
        if (value) {
            const formattedValue = typeof value === 'object' ? JSON.stringify(value) : value;
            const valueStyle = level === 'error' ? chalk.red : 
                             level === 'warn' ? chalk.yellow : 
                             chalk.green;
            formattedMessage += ` ${valueStyle(formattedValue)}`;
        }

        if (error && this.verbose) {
            formattedMessage += `\n${chalk.red(this._formatError(error))}`;
        }

        console.log(formattedMessage);
    },

    info: (message, value = '') => logger.log('info', message, value),
    warn: (message, value = '') => logger.log('warn', message, value),
    error: (message, value = '', error = null) => logger.log('error', message, value, error),
    success: (message, value = '') => logger.log('success', message, value),
    debug: (message, value = '') => logger.log('debug', message, value),
    verbose: (message, value = '') => logger.verbose && logger.log('verbose', message, value),

    progress(wallet, step, status) {
        const progressStyle = status === 'success' 
            ? chalk.green('✔') 
            : status === 'failed' 
            ? chalk.red('✘') 
            : chalk.yellow('➤');
        
        console.log(
            chalk.cyan('◆ LayerEdge Auto Bot'),
            chalk.gray(`[${new Date().toLocaleTimeString()}]`),
            chalk.blueBright(`[PROGRESS]`),
            `${progressStyle} ${wallet} - ${step}`
        );
    }
};

class RequestHandler {
    static async makeRequest(config, retries = 30, backoffMs = 2000) {
        for (let i = 0; i < retries; i++) {
            try {
                logger.verbose(`尝试请求 (${i + 1}/${retries})`, `URL: ${config.url}`);
                const response = await axios(config);
                logger.verbose(`请求成功`, `状态码: ${response.status}`);
                return response;
            } catch (error) {
                const isLastRetry = i === retries - 1;
                const status = error.response?.status;
                
                if (status === 500) {
                    logger.error(`服务器错误 (500)`, `尝试次数 ${i + 1}/${retries}`, error);
                    if (isLastRetry) break;
                    
                    const waitTime = backoffMs * Math.pow(1.5, i);
                    logger.warn(`等待 ${waitTime/1000}秒后重试...`);
                    await delay(waitTime/1000);
                    continue;
                }

                if (isLastRetry) {
                    logger.error(`达到最大重试次数`, '', error);
                    return null;
                }

                logger.warn(`请求失败`, `尝试次数 ${i + 1}/${retries}`, error);
                await delay(2);
            }
        }
        return null;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms * 1000));
}

async function saveToFile(filename, data) {
    try {
        await fs.appendFile(filename, `${data}\n`, 'utf-8');
        logger.info(`数据已保存到 ${filename}`);
    } catch (error) {
        logger.error(`保存数据到 ${filename} 失败: ${error.message}`);
    }
}

async function readFile(pathFile) {
    try {
        const datas = await fs.readFile(pathFile, 'utf8');
        return datas.split('\n')
            .map(data => data.trim())
            .filter(data => data.length > 0);
    } catch (error) {
        logger.error(`读取文件错误: ${error.message}`);
        return [];
    }
}

const newAgent = (proxy = null) => {
    if (!proxy) return null;

    // 处理格式: ip:port:username:password
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+:[^:]+:[^:]+$/.test(proxy)) {
        const [ip, port, username, password] = proxy.split(':');
        const formattedProxy = `http://${username}:${password}@${ip}:${port}`;
        return new HttpsProxyAgent(formattedProxy);
    }
    
    // 处理格式: ip:port
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(proxy)) {
        const formattedProxy = `http://${proxy}`;
        return new HttpsProxyAgent(formattedProxy);
    }

    // 处理标准格式
    if (proxy.startsWith('http://')) {
        return new HttpsProxyAgent(proxy);
    } else if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        return new SocksProxyAgent(proxy);
    }

    logger.warn(`不支持的代理格式: ${proxy}`);
    return null;
};

class LayerEdgeConnection {
    constructor(proxy = null, privateKey = null, refCode = "knYyWnsE") {
        this.refCode = refCode;
        this.proxy = proxy;
        this.retryCount = 30;

        this.headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://layeredge.io',
            'Referer': 'https://layeredge.io/',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
        };

        this.axiosConfig = {
            ...(this.proxy && { httpsAgent: newAgent(this.proxy) }),
            timeout: 60000,
            headers: this.headers,
            validateStatus: (status) => status < 500
        };

        this.wallet = privateKey
            ? new Wallet(privateKey)
            : Wallet.createRandom();
            
        logger.verbose(`初始化 LayerEdge 连接`, 
            `钱包: ${this.wallet.address}\n代理: ${this.proxy || '未使用代理'}`);
    }

    async makeRequest(method, url, config = {}) {
        const finalConfig = {
            method,
            url,
            ...this.axiosConfig,
            ...config,
            headers: {
                ...this.headers,
                ...(config.headers || {})
            }
        };
        
        return await RequestHandler.makeRequest(finalConfig, this.retryCount);
    }

    async checkInvite() {
        const inviteData = {
            invite_code: this.refCode,
        };

        const response = await this.makeRequest(
            "post",
            "https://referralapi.layeredge.io/api/referral/verify-referral-code",
            { data: inviteData }
        );

        if (response && response.data && response.data.data.valid === true) {
            logger.info("邀请码验证成功", response.data);
            return true;
        } else {
            logger.error("邀请码验证失败");
            return false;
        }
    }

    async registerWallet() {
        const registerData = {
            walletAddress: this.wallet.address,
        };

        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/referral/register-wallet/${this.refCode}`,
            { data: registerData }
        );

        if (response && response.data) {
            logger.info("钱包注册成功", response.data);
            return true;
        } else {
            logger.error("钱包注册失败", "error");
            return false;
        }
    }

    async connectNode() {
        const timestamp = Date.now();
        const message = `Node activation request for ${this.wallet.address} at ${timestamp}`;
        const sign = await this.wallet.signMessage(message);

        const dataSign = {
            sign: sign,
            timestamp: timestamp,
        };

        const config = {
            data: dataSign,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/light-node/node-action/${this.wallet.address}/start`,
            config
        );

        if (response && response.data && response.data.message === "node action executed successfully") {
            logger.info("节点连接成功", response.data);
            return true;
        } else {
            logger.info("节点连接失败");
            return false;
        }
    }

    async stopNode() {
        const timestamp = Date.now();
        const message = `Node deactivation request for ${this.wallet.address} at ${timestamp}`;
        const sign = await this.wallet.signMessage(message);

        const dataSign = {
            sign: sign,
            timestamp: timestamp,
        };

        const response = await this.makeRequest(
            "post",
            `https://referralapi.layeredge.io/api/light-node/node-action/${this.wallet.address}/stop`,
            { data: dataSign }
        );

        if (response && response.data) {
            logger.info("停止节点并领取积分结果:", response.data);
            return true;
        } else {
            logger.error("停止节点并领取积分失败");
            return false;
        }
    }

    async dailyCheckIn() {
        try {
            const timestamp = Date.now();
            const message = `I am claiming my daily node point for ${this.wallet.address} at ${timestamp}`;
            const sign = await this.wallet.signMessage(message);
            const dataSign = { sign, timestamp, walletAddress: this.wallet.address };
            const config = {
                data: dataSign,
                headers: { 'Content-Type': 'application/json' }
            };

            const response = await this.makeRequest(
                "post",
                "https://referralapi.layeredge.io/api/light-node/claim-node-points",
                config
            );

            if (response && response.data) {
                if (response.data.statusCode && response.data.statusCode === 405) {
                    const cooldownMatch = response.data.message.match(/after\s+([^!]+)!/);
                    const cooldownTime = cooldownMatch ? cooldownMatch[1].trim() : "未知时间";
                    logger.info("⚠️ 今日已签到", `${cooldownTime}后可再次签到`);
                    return true;
                } else {
                    logger.info("✅ 签到成功", response.data);
                    return true;
                }
            } else {
                logger.error("❌ 签到失败");
                return false;
            }
        } catch (error) {
            logger.error("签到过程中出错:", error);
            return false;
        }
    }

    async checkNodeStatus() {
        const response = await this.makeRequest(
            "get",
            `https://referralapi.layeredge.io/api/light-node/node-status/${this.wallet.address}`
        );

        if (response && response.data && response.data.data.startTimestamp !== null) {
            logger.info("节点运行状态", response.data);
            return true;
        } else {
            logger.error("节点未运行，尝试启动节点...");
            return false;
        }
    }

    async checkNodePoints() {
        const response = await this.makeRequest(
            "get",
            `https://referralapi.layeredge.io/api/referral/wallet-details/${this.wallet.address}`
        );

        if (response && response.data) {
            logger.info(`${this.wallet.address} 总积分:`, response.data.data?.nodePoints || 0);
            return true;
        } else {
            logger.error("检查总积分失败...");
            return false;
        }
    }

    async submitProof() {
        try {
            const timestamp = new Date().toISOString();
            const message = `I am submitting a proof for LayerEdge at ${timestamp}`;
            const signature = await this.wallet.signMessage(message);
            
            const proofData = {
                proof: "GmEdgesss",
                signature: signature,
                message: message,
                address: this.wallet.address
            };

            const config = {
                data: proofData,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': '*/*'
                }
            };

            const response = await this.makeRequest(
                "post",
                "https://dashboard.layeredge.io/api/send-proof",
                config
            );

            if (response && response.data && response.data.success) {
                logger.success("证明提交成功", response.data.message);
                return true;
            } else {
                logger.error("证明提交失败", response?.data);
                return false;
            }
        } catch (error) {
            logger.error("提交证明时出错", "", error);
            return false;
        }
    }

    async claimProofSubmissionPoints() {
        try {
            const timestamp = Date.now();
            const message = `I am claiming my proof submission node points for ${this.wallet.address} at ${timestamp}`;
            const sign = await this.wallet.signMessage(message);

            const claimData = {
                walletAddress: this.wallet.address,
                timestamp: timestamp,
                sign: sign
            };

            const config = {
                data: claimData,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                }
            };

            const response = await this.makeRequest(
                "post",
                "https://referralapi.layeredge.io/api/task/proof-submission",
                config
            );

            if (response && response.data && response.data.message === "proof submission task completed successfully") {
                logger.success("证明提交积分领取成功");
                return true;
            } else {
                logger.error("证明提交积分领取失败", response?.data);
                return false;
            }
        } catch (error) {
            logger.error("领取证明提交积分时出错", "", error);
            return false;
        }
    }

    async claimLightNodePoints() {
        try {
            const timestamp = Date.now();
            const message = `I am claiming my light node run task node points for ${this.wallet.address} at ${timestamp}`;
            const sign = await this.wallet.signMessage(message);

            const claimData = {
                walletAddress: this.wallet.address,
                timestamp: timestamp,
                sign: sign
            };

            const config = {
                data: claimData,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                }
            };

            const response = await this.makeRequest(
                "post",
                "https://referralapi.layeredge.io/api/task/node-points",
                config
            );

            if (response && response.data && response.data.message === "node points task completed successfully") {
                logger.success("轻节点积分领取成功");
                return true;
            } else {
                logger.error("轻节点积分领取失败", response?.data);
                return false;
            }
        } catch (error) {
            logger.error("领取轻节点积分时出错", "", error);
            return false;
        }
    }
}

async function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(chalk.cyan(`◆ ${question}`), (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function inputWalletAndProxy() {
    logger.info('开始输入钱包和代理信息');
    
    const wallets = [];
    const proxies = [];
    
    while (true) {
        console.log('\n' + chalk.yellow('=== 输入新的钱包和代理 (输入 "done" 结束) ==='));
        
        const privateKey = await askQuestion('请输入私钥 (或输入 "done" 结束): ');
        if (privateKey.toLowerCase() === 'done') break;
        
        try {
            const wallet = new Wallet(privateKey);
            const proxy = await askQuestion('请输入代理 (格式: ip:port 或 ip:port:user:pass，直接回车跳过): ');
            
            wallets.push({
                address: wallet.address,
                privateKey: wallet.privateKey
            });
            
            if (proxy.trim()) {
                proxies.push(proxy.trim());
            }
            
            logger.success(`已添加钱包: ${wallet.address}`);
        } catch (error) {
            logger.error('无效的私钥，请重试', error.message);
            continue;
        }
    }
    
    if (wallets.length > 0) {
        await fs.writeFile('wallets.json', JSON.stringify(wallets, null, 2));
        logger.success('钱包信息已保存到 wallets.json');
    }
    
    if (proxies.length > 0) {
        await fs.writeFile('proxy.txt', proxies.join('\n'));
        logger.success('代理信息已保存到 proxy.txt');
    }
    
    return { wallets, proxies };
}

async function run() {
    const banner = await import('./utils/banner.js');
    banner.default();
    logger.info('LayerEdge 自动任务机器人启动', '初始化中...');
    
    try {
        const useExisting = await askQuestion('是否使用现有配置文件？(y/n): ');
        
        let wallets = [];
        let proxies = [];
        
        if (useExisting.toLowerCase() === 'y') {
            try {
                const walletsData = await fs.readFile('wallets.json', 'utf8');
                wallets = JSON.parse(walletsData);
                proxies = await readFile('proxy.txt');
                logger.info('已加载现有配置', `钱包: ${wallets.length}个, 代理: ${proxies.length}个`);
            } catch (err) {
                logger.error('加载现有配置失败，将使用新配置');
                const result = await inputWalletAndProxy();
                wallets = result.wallets;
                proxies = result.proxies;
            }
        } else {
            const result = await inputWalletAndProxy();
            wallets = result.wallets;
            proxies = result.proxies;
        }
        
        if (wallets.length === 0) {
            throw new Error('未配置任何钱包');
        }

        while (true) {
            for (let i = 0; i < wallets.length; i++) {
                const wallet = wallets[i];
                const proxy = proxies[i % proxies.length] || null;
                const { address, privateKey } = wallet;
                
                try {
                    logger.verbose(`正在处理钱包 ${i + 1}/${wallets.length}`, address);
                    const socket = new LayerEdgeConnection(proxy, privateKey);
                    
                    logger.progress(address, '开始处理钱包', 'start');
                    logger.info(`钱包信息`, `地址: ${address}, 代理: ${proxy || '未使用代理'}`);

                    logger.progress(address, '执行每日签到', 'processing');
                    await socket.dailyCheckIn();

                    logger.progress(address, '提交证明', 'processing');
                    await socket.submitProof();

                    logger.progress(address, '领取提交证明积分', 'processing');
                    await socket.claimProofSubmissionPoints();

                    logger.progress(address, '检查节点状态', 'processing');
                    const isRunning = await socket.checkNodeStatus();

                    if (isRunning) {
                        logger.progress(address, '领取节点积分', 'processing');
                        await socket.stopNode();
                    }

                    logger.progress(address, '重新连接节点', 'processing');
                    await socket.connectNode();

                    logger.progress(address, '领取轻节点积分', 'processing');
                    await socket.claimLightNodePoints();

                    logger.progress(address, '检查节点积分', 'processing');
                    await socket.checkNodePoints();

                    logger.progress(address, '钱包处理完成', 'success');
                } catch (error) {
                    logger.error(`钱包 ${address} 处理失败`, '', error);
                    logger.progress(address, '钱包处理失败', 'failed');
                    await delay(5);
                }
            }
            
            logger.warn('本轮任务完成', '等待1小时后开始下一轮...');
            await delay(60 * 60);
        }
    } catch (error) {
        logger.error('发生致命错误', '', error);
        process.exit(1);
    }
}

run();
