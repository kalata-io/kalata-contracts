const {getResourceFolder, readContracts, readUSD} = require("../utils/resources")
const path = require('path');
const {readJson, saveJson} = require("../utils/json")
const {toUnit,} = require("../utils/maths")
const {loadToken, loadUniswapV2Factory, loadUniswapV2Router02, ZERO_ADDRESS, estiamteGasAndCallMethod} = require("../utils/contract")
const {stringToBytes32} = require('../utils/bytes')

let initialSupply = toUnit("980000000").toString();

function sleep(hre, seconds) {
    //let ms = hre.network.name === "hardhat" || hre.network.name === "localhost" ? seconds : seconds * 1000;
    let network = hre.network.name;
    let ms = seconds * 1000;
    if (network === "hardhat") {
        ms = seconds;
    } else if (network === "localhost") {
        ms = seconds * 100;
    }
    return new Promise(resolve => setTimeout(resolve, ms));
}

const MOCK_ASSETS = {
    "kApple": {name: "Apple Token", type: "stock", sinaCode: "gb_aapl", gtimgCode: "usAAPL", initialSupply},
    "kABNB": {name: "ABNB Token", type: "stock", sinaCode: "gb_abnb", gtimgCode: "usABNB", initialSupply},
    "kAMC": {name: "Amc Token", type: "stock", sinaCode: "gb_amc", gtimgCode: "usAMC", initialSupply},
    "kAMZN": {name: "Amzn Token", type: "stock", sinaCode: "gb_amzn", gtimgCode: "usAMZN", initialSupply},
    "kBABA": {name: "Alibaba Token", type: "stock", sinaCode: "gb_baba", gtimgCode: "usBABA", initialSupply},
    "kGOOGL": {name: "Google Token", type: "stock", sinaCode: "gb_goog", gtimgCode: "usGOOG", initialSupply},

    //coin list:  https://api.coingecko.com/api/v3/coins/list?include_platform=false
    "kBTC": {name: "BTC Token", type: "crptoCurrency", initialSupply, coingeckoCoinId: "bitcoin"},
    "kETH": {name: "ETH Token", type: "crptoCurrency", initialSupply, coingeckoCoinId: "ethereum"},
    "kBCH": {name: "BCH Token", type: "crptoCurrency", initialSupply, coingeckoCoinId: "bitcoin-cash"},
}

let assetPath;
let deployedAssets;
let uniswapV2Factory;
let usdToken;
let factoryInstance;

async function createPairs(hre) {
    uniswapV2Factory = await loadUniswapV2Factory(hre);
    let [deployer, lpOwner] = await hre.ethers.getSigners();
    let deployedContracts = readContracts(hre) || {};
    let Artifact = await hre.artifacts.readArtifact("Factory");
    factoryInstance = new hre.ethers.Contract(deployedContracts["Factory"].address, Artifact.abi, deployer);
    let oracleFeeder = deployer.address;
    let auctionDiscount = toUnit("0.50")
    let minCollateralRatio = toUnit("1.5");
    let weight = toUnit("1");
    let usdInfo = readUSD(hre);
    usdToken = await loadToken(hre, usdInfo.address);

    assetPath = path.resolve(getResourceFolder(hre), "assets.json");
    deployedAssets = readJson(assetPath) || {};

    for (let symbol of Object.keys(MOCK_ASSETS)) {
        let {name, type, initialSupply, sinaCode, gtimgCode, coingeckoCoinId} = MOCK_ASSETS[symbol];
        let assetInfo = deployedAssets[symbol] || {
            name, symbol, initialSupply, type, pool: null, address: null, pair: null, deploy: true, sinaCode, gtimgCode, coingeckoCoinId,
            icon: `https://api.kalata.io/api/deployed/icons/${symbol.toUpperCase()}.png`
        }
        let assetAddress = assetInfo.address;
        if (assetInfo.deploy) {
            let bytes32Name = stringToBytes32(name);
            let bytes32Symbol = stringToBytes32(symbol);
            let factoryConfig = await factoryInstance.queryConfig();
            if (factoryConfig.baseToken !== usdToken.address) {
                console.error("factory.baseToken != usdToken")
                process.exit(503);
            }

            await factoryInstance.whitelist(
                bytes32Name,
                bytes32Symbol,
                oracleFeeder,
                auctionDiscount.toString(),
                minCollateralRatio.toString(),
                weight.toString(),
                //{gasLimit: 19500000}
            ).catch(error => {
                console.error(`whitelist error:${error}`);
            });

            await sleep(hre, 10);
            assetAddress = await factoryInstance.queryToken(bytes32Symbol);
            if (assetAddress === ZERO_ADDRESS) {
                console.error(`Asset ${symbol} deployed to network ${hre.network.name} with address ${assetAddress}`)
                process.exit(502);
            } else {
                console.log(`Asset ${symbol} deployed to network ${hre.network.name} with address ${assetAddress}`);
                let assetToken = await loadToken(hre, assetAddress);
                await assetToken.mint(deployer.address, initialSupply);
                await sleep(hre, 2);
                let pair = await uniswapV2Factory.getPair(usdToken.address, assetAddress);
                assetInfo.address = assetAddress;
                assetInfo.pair = pair;
                assetInfo.deploy = false;
                deployedAssets[symbol] = assetInfo;

                console.log(`Pair ${symbol}/${usdInfo.symbol} deployed to network ${hre.network.name} with address ${pair}`);

                //saveJson(assetPath, deployedAssets);

                let [assetAmount, usdAmount] = [toUnit("1000"), toUnit("1000")]
                await addLiquidity(hre, lpOwner, assetAddress, assetAmount, usdAmount);
                assetInfo.pool = {
                    lp: lpOwner.address,
                    assetAmount: assetAmount.toString(),
                    usdAmount: usdAmount.toString()
                };
                saveJson(assetPath, deployedAssets);
            }
        }


    }
}


//function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline)
async function addLiquidity(hre, lpOwner, assetAddress, assetAmount, usdAmount) {
    if (!assetAddress) {
        return;
    }
    let assetToken = await loadToken(hre, assetAddress);
    assetToken.transfer(lpOwner.address, assetAmount.toString());
    await sleep(hre, 2);
    usdToken.transfer(lpOwner.address, usdAmount.toString());
    await sleep(hre, 2);

    let [to, deadline] = [lpOwner.address, (await hre.web3.eth.getBlock("latest")).timestamp + 160];

    let callerUsdToken = await loadToken(hre, usdToken.address, lpOwner);
    let callerAssetToken = await loadToken(hre, assetToken.address, lpOwner);

    let [assetAmountDesired, usdAmountDesired] = [assetAmount, usdAmount];
    let [assetAmountMin, usdAmounMin] = [assetAmountDesired, usdAmountDesired];
    let callerRouter = await loadUniswapV2Router02(hre, lpOwner);

    await callerUsdToken.approve(callerRouter.address, usdAmountDesired.toString(), {gasLimit: 2500000});
    await sleep(hre, 5);
    await callerAssetToken.approve(callerRouter.address, assetAmountDesired.toString(), {gasLimit: 2500000});
    await sleep(hre, 5);

    await callerRouter.addLiquidity(usdToken.address, assetToken.address,
        usdAmountDesired.toString(),
        assetAmountDesired.toString(),
        usdAmounMin.toString(),
        assetAmountMin.toString(),
        to,
        deadline, {gasLimit: 9500000}
    );
    await sleep(hre, 5);
}


module.exports = {
    deploy: async (hre) => {
        //await deployStockAssets(hre);
        //await deployCrptoCurrencyAssets(hre);
        await createPairs(hre);
        //await addLiquidity(hre);
    }
}
